import crypto from "node:crypto";
import { config } from "./config.js";
import { loadProviderModels } from "./aiCatalog.js";
import type { AiProviderRuntime, AiProviderSettings, Store } from "./types.js";

export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string };
export type ToolDefinition = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ToolCall = { id: string; function: { name: string; arguments: string } };
export type Completion = { content: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number; provider: string; model: string };

export const PUBLIC_AI_ERROR = "The agent could not generate a response right now. Please try again later.";
export function publicAIError(_error: unknown): string { return PUBLIC_AI_ERROR; }

function redacted(value: unknown): string {
  return String(value).replace(/([?&](?:key|api[_-]?key|token|authorization)=)[^&\s]*/gi, "$1[REDACTED]").replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]").slice(0, 4000);
}
function providerFailure(provider: AiProviderRuntime, detail: unknown): Error { console.error("[Gbolix ai-provider] request_failed", JSON.stringify({ providerId: provider.id, adapter: provider.adapter, detail: redacted(detail) })); return new Error(PUBLIC_AI_ERROR); }

export function encryptProviderApiKey(value: string): string { const secret = config.connectionEncryptionKey ?? config.agentJwtSecret; if (!secret) throw new Error("Provider secret encryption is not configured."); const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), iv); const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`; }
function decryptProviderApiKey(value: string): string { const secret = config.connectionEncryptionKey ?? config.agentJwtSecret; if (!secret) throw new Error("Provider secret encryption is not configured."); const parts = value.split(":"); if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid provider secret format."); const iv = Buffer.from(parts[1], "base64url"); const tag = Buffer.from(parts[2], "base64url"); const ciphertext = Buffer.from(parts[3], "base64url"); const decipher = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"); }
export async function resolveAiProviders(store: Pick<Store, "listAiProviderSecrets">): Promise<AiProviderRuntime[] | undefined> { let stored; try { stored = await store.listAiProviderSecrets(); } catch (error) { console.error("[Gbolix ai-provider] registry_read_failed", JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return undefined; } if (!stored.length) return undefined; const providers: AiProviderRuntime[] = []; for (const item of stored) { if (!item.enabled || !item.encryptedApiKey) continue; try { providers.push({ id: item.id, name: item.name, adapter: item.adapter, baseUrl: item.baseUrl, apiKey: decryptProviderApiKey(item.encryptedApiKey), defaultModel: item.defaultModel, priority: item.priority, enabled: item.enabled }); } catch (error) { console.error("[Gbolix ai-provider] secret_decrypt_failed", JSON.stringify({ providerId: item.id, error: error instanceof Error ? error.message : String(error) })); } } return providers; }

function environmentProviders(): AiProviderRuntime[] {
  const providers: AiProviderRuntime[] = [];
  if (config.geminiApiKey) providers.push({ id: "gemini", name: "Gemini", adapter: "gemini", baseUrl: config.geminiBaseUrl, apiKey: config.geminiApiKey, defaultModel: config.geminiModel, priority: 100, enabled: true });
  if (config.openAiApiKey) providers.push({ id: "openai", name: "OpenAI-compatible", adapter: "openai_compatible", baseUrl: config.openAiBaseUrl, apiKey: config.openAiApiKey, defaultModel: config.openAiModel, priority: 200, enabled: true });
  return providers;
}
function providerOrder(settings: AiProviderSettings | undefined, providers: AiProviderRuntime[]): AiProviderRuntime[] {
  const byId = new Map(providers.filter((provider) => provider.enabled).map((provider) => [provider.id, provider]));
  const configured = settings?.providerOrder?.length ? settings.providerOrder : providers.slice().sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).map((provider) => provider.id);
  const ordered = configured.map((id) => byId.get(id)).filter((provider): provider is AiProviderRuntime => Boolean(provider));
  return ordered.length ? [...new Map(ordered.map((provider) => [provider.id, provider])).values()] : providers.filter((provider) => provider.enabled);
}

const liveModelCache = new Map<string, { checkedAt: number; models: string[] }>();
export function clearProviderModelCache(providerId?: string) { if (providerId) liveModelCache.delete(providerId); else liveModelCache.clear(); }
async function liveModels(provider: AiProviderRuntime): Promise<string[] | undefined> {
  const cached = liveModelCache.get(provider.id);
  if (cached && Date.now() - cached.checkedAt < 5 * 60 * 1000) return cached.models;
  try {
    const models = await loadProviderModels(provider);
    const ids = models.filter((item) => item.live && !item.deprecated).map((item) => item.id);
    liveModelCache.set(provider.id, { checkedAt: Date.now(), models: ids });
    return ids;
  } catch (error) {
    console.error("[Gbolix ai-provider] live_model_check_failed", JSON.stringify({ providerId: provider.id, adapter: provider.adapter, error: error instanceof Error ? error.message : String(error) }));
    return undefined;
  }
}
async function modelCandidates(provider: AiProviderRuntime, requested: string, settings?: AiProviderSettings): Promise<string[]> {
  const selected = settings?.models?.[provider.id];
  const requestedDefault = provider.adapter === "gemini" && requested.startsWith("gemini-") ? requested : provider.defaultModel;
  if (settings?.autoUpdateModels !== false) {
    const live = await liveModels(provider);
    if (live?.length) return [...new Set([selected, requestedDefault, ...live].filter((item): item is string => Boolean(item)).filter((item) => live.includes(item)))];
  }
  return [selected || requestedDefault];
}

export async function complete(input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[]; settings?: AiProviderSettings; providers?: AiProviderRuntime[] }): Promise<Completion> {
  const providers = providerOrder(input.settings, input.providers !== undefined ? input.providers : environmentProviders());
  if (!providers.length) return fallbackCompletion(input.messages);
  let lastError: unknown;
  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex];
    const candidates = await modelCandidates(provider, input.model, input.settings);
    for (let modelIndex = 0; modelIndex < candidates.length; modelIndex += 1) {
      const model = candidates[modelIndex];
      try {
        const completion = provider.adapter === "gemini" ? await completeWithGemini(provider, input, model) : await completeWithOpenAI(provider, input, model);
        if (providerIndex > 0 || modelIndex > 0) console.info("[Gbolix ai-provider] fallback_succeeded", JSON.stringify({ providerId: provider.id, model, providerAttempt: providerIndex + 1, modelAttempt: modelIndex + 1 }));
        return completion;
      } catch (error) {
        lastError = error;
        console.error("[Gbolix ai-provider] fallback_attempt_failed", JSON.stringify({ providerId: provider.id, model, providerAttempt: providerIndex + 1, modelAttempt: modelIndex + 1, hasNextModel: modelIndex < candidates.length - 1, hasNextProvider: providerIndex < providers.length - 1, error: error instanceof Error ? error.message : String(error) }));
        if (!(input.settings?.fallbackEnabled ?? config.aiFallbackEnabled)) break;
      }
    }
    if (!(input.settings?.fallbackEnabled ?? config.aiFallbackEnabled)) break;
  }
  if (!lastError) return fallbackCompletion(input.messages);
  throw new Error(publicAIError(lastError));
}

async function completeWithOpenAI(provider: AiProviderRuntime, input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[] }, model: string): Promise<Completion> {
  let response: Response;
  try { response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify({ model, messages: input.messages, tools: input.tools?.length ? input.tools : undefined, tool_choice: input.tools?.length ? "auto" : undefined, temperature: 0.3 }) }); }
  catch (error) { throw providerFailure(provider, error); }
  if (!response.ok) throw providerFailure(provider, `HTTP ${response.status}: ${await response.text().catch(() => "response body unavailable")}`);
  let data: any;
  try { data = await response.json(); } catch (error) { throw providerFailure(provider, error); }
  const message = data.choices?.[0]?.message;
  if (!message) throw providerFailure(provider, "provider returned no message");
  return { content: typeof message.content === "string" ? message.content : "", toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [], inputTokens: Number(data.usage?.prompt_tokens ?? 0), outputTokens: Number(data.usage?.completion_tokens ?? 0), provider: provider.id, model };
}

async function completeWithGemini(provider: AiProviderRuntime, input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[] }, model: string): Promise<Completion> {
  const system = input.messages.find((message) => message.role === "system")?.content;
  const contents = input.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.role === "tool" ? `Tool result (${message.name ?? "tool"}): ${message.content}` : message.content }] }));
  const body: Record<string, unknown> = { contents, generationConfig: { temperature: 0.3 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (input.tools?.length) body.tools = [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }];
  let response: Response;
  try { response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch (error) { throw providerFailure(provider, error); }
  if (!response.ok) throw providerFailure(provider, `HTTP ${response.status}: ${await response.text().catch(() => "response body unavailable")}`);
  let data: any;
  try { data = await response.json(); } catch (error) { throw providerFailure(provider, error); }
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const content = parts.filter((part: any) => typeof part.text === "string").map((part: any) => part.text).join("\n");
  const toolCalls = parts.filter((part: any) => part.functionCall?.name).map((part: any, index: number) => ({ id: `ai_call_${index}`, function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } }));
  if (!content && !toolCalls.length) throw providerFailure(provider, "provider returned no message");
  return { content, toolCalls, inputTokens: Number(data.usageMetadata?.promptTokenCount ?? 0), outputTokens: Number(data.usageMetadata?.candidatesTokenCount ?? 0), provider: provider.id, model };
}

function fallbackCompletion(messages: ChatMessage[]): Completion {
  const last = [...messages].reverse().find((item) => item.role === "user")?.content ?? "";
  const context = messages.find((item) => item.role === "system")?.content ?? "";
  const wantsHandoff = /human|person|agent|representative|complaint/i.test(last);
  const response = wantsHandoff ? "I’ll connect you with a member of the team so they can help you directly." : context.includes("Knowledge:") ? `Based on the business information I have, here is what I can share: ${context.split("Knowledge:")[1]?.slice(0, 220).trim() || "I’m ready to help with your request."}` : `Thanks for reaching out. I’m ready to help with: ${last.slice(0, 180)}.`;
  return { content: response, toolCalls: [], inputTokens: Math.ceil(last.length / 4), outputTokens: Math.ceil(response.length / 4), provider: "local_fallback", model: "fallback" };
}
