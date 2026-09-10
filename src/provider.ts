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
type ProviderFailureMetadata = { httpStatus?: number; rateLimited?: boolean; quotaError?: boolean; retryAfterMs?: number; errorCode?: string };
function providerFailure(provider: AiProviderRuntime, detail: unknown, metadata: ProviderFailureMetadata = {}): Error { console.error("[Gbolix ai-provider] request_failed", JSON.stringify({ providerId: provider.id, adapter: provider.adapter, detail: redacted(detail), ...metadata })); const error = new Error(PUBLIC_AI_ERROR) as Error & ProviderFailureMetadata; Object.assign(error, metadata); return error; }
function retryAfterMs(value: string | null): number | undefined { if (!value) return undefined; const seconds = Number(value); if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000)); const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined; }
function failureMetadata(status: number, body: string, headers: Headers): ProviderFailureMetadata { const normalized = body.toLowerCase(); return { httpStatus: status, rateLimited: status === 429 || /rate.?limit|too many requests|resource_exhausted/.test(normalized), quotaError: /quota|billing|insufficient[_ ]?quota|resource_exhausted/.test(normalized), retryAfterMs: retryAfterMs(headers.get("retry-after")), errorCode: status >= 500 ? "provider_server_error" : status === 429 ? "rate_limited" : undefined }; }

export function encryptProviderApiKey(value: string): string { const secret = config.connectionEncryptionKey ?? config.agentJwtSecret; if (!secret) throw new Error("Provider secret encryption is not configured."); const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), iv); const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`; }
function decryptProviderApiKey(value: string): string { const secret = config.connectionEncryptionKey ?? config.agentJwtSecret; if (!secret) throw new Error("Provider secret encryption is not configured."); const parts = value.split(":"); if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid provider secret format."); const iv = Buffer.from(parts[1], "base64url"); const tag = Buffer.from(parts[2], "base64url"); const ciphertext = Buffer.from(parts[3], "base64url"); const decipher = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"); }
export async function resolveAiProviders(store: Pick<Store, "listAiProviderSecrets">): Promise<AiProviderRuntime[] | undefined> { let stored; try { stored = await store.listAiProviderSecrets(); } catch (error) { console.error("[Gbolix ai-provider] registry_read_failed", JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return undefined; } if (!stored.length) return undefined; const providers: AiProviderRuntime[] = []; for (const item of stored) { if (!item.enabled || !item.encryptedApiKey) continue; try { providers.push({ id: item.id, name: item.name, adapter: item.adapter, baseUrl: item.baseUrl, apiKey: decryptProviderApiKey(item.encryptedApiKey), defaultModel: item.defaultModel, priority: item.priority, enabled: item.enabled, trafficWeight: item.trafficWeight ?? 100, fallbackEnabled: item.fallbackEnabled !== false, capacityMode: item.capacityMode ?? "auto", rpmLimit: item.rpmLimit, tpmLimit: item.tpmLimit, rpdLimit: item.rpdLimit, safetyMargin: item.safetyMargin ?? 20, cooldownUntil: item.cooldownUntil, healthStatus: item.healthStatus ?? "unknown" }); } catch (error) { console.error("[Gbolix ai-provider] secret_decrypt_failed", JSON.stringify({ providerId: item.id, error: error instanceof Error ? error.message : String(error) })); } } return providers; }

function environmentProviders(): AiProviderRuntime[] {
  const providers: AiProviderRuntime[] = [];
  if (config.geminiApiKey) providers.push({ id: "gemini", name: "Gemini", adapter: "gemini", baseUrl: config.geminiBaseUrl, apiKey: config.geminiApiKey, defaultModel: config.geminiModel, priority: 100, enabled: true, trafficWeight: 100, fallbackEnabled: true, capacityMode: "auto", safetyMargin: 20, healthStatus: "unknown" });
  if (config.openAiApiKey) providers.push({ id: "openai", name: "OpenAI-compatible", adapter: "openai_compatible", baseUrl: config.openAiBaseUrl, apiKey: config.openAiApiKey, defaultModel: config.openAiModel, priority: 200, enabled: true, trafficWeight: 100, fallbackEnabled: true, capacityMode: "auto", safetyMargin: 20, healthStatus: "unknown" });
  return providers;
}
function providerOrder(settings: AiProviderSettings | undefined, providers: AiProviderRuntime[], requestId?: string): AiProviderRuntime[] {
  const byId = new Map(providers.filter((provider) => provider.enabled).map((provider) => [provider.id, provider]));
  const configured = settings?.providerOrder?.length ? settings.providerOrder : providers.slice().sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).map((provider) => provider.id);
  const ordered = configured.map((id) => byId.get(id)).filter((provider): provider is AiProviderRuntime => Boolean(provider));
  const eligible = ordered.length ? [...new Map(ordered.map((provider) => [provider.id, provider])).values()] : providers.filter((provider) => provider.enabled);
  const now = Date.now();
  return weightedOrder(eligible.filter((provider) => provider.healthStatus !== "full" && (!(provider.healthStatus === "cooldown") || !provider.cooldownUntil || Date.parse(provider.cooldownUntil) <= now) && (!provider.cooldownUntil || Date.parse(provider.cooldownUntil) <= now)), requestId);
}

function weightedOrder(providers: AiProviderRuntime[], requestId?: string): AiProviderRuntime[] {
  if (!requestId) return providers;
  const remaining = providers.slice(); const selected: AiProviderRuntime[] = []; let seed = [...requestId].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 7);
  while (remaining.length) { const total = remaining.reduce((sum, provider) => sum + Math.max(1, provider.trafficWeight ?? 100), 0); seed = (seed * 1664525 + 1013904223) >>> 0; let cursor = (seed / 0x100000000) * total; let index = 0; for (; index < remaining.length - 1; index += 1) { cursor -= Math.max(1, remaining[index].trafficWeight ?? 100); if (cursor < 0) break; } selected.push(remaining.splice(index, 1)[0]); }
  return selected;
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

export async function runProviderHealthChecks(store: Pick<Store, "listAiProviderSecrets" | "recordAiProviderAttempt">): Promise<void> {
  const providers = await resolveAiProviders(store);
  for (const provider of providers ?? []) {
    const started = Date.now();
    try {
      const models = await loadProviderModels(provider);
      await store.recordAiProviderAttempt({ providerId: provider.id, model: provider.defaultModel || models[0]?.id || "health-check", inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, success: models.length > 0, errorCode: models.length ? undefined : "NO_LIVE_MODELS" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = /429|rate.?limit/i.test(message);
      const quotaError = /quota|billing|insufficient/i.test(message);
      await store.recordAiProviderAttempt({ providerId: provider.id, model: provider.defaultModel || "health-check", inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, success: false, rateLimited, quotaError, errorCode: rateLimited ? "RATE_LIMITED" : quotaError ? "QUOTA_EXCEEDED" : "HEALTH_CHECK_FAILED" });
    }
  }
}

export async function complete(input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[]; settings?: AiProviderSettings; providers?: AiProviderRuntime[]; store?: Pick<Store, "reserveAiProviderCapacity" | "finalizeAiProviderReservation" | "recordAiProviderAttempt">; requestId?: string }): Promise<Completion> {
  const providers = providerOrder(input.settings, input.providers !== undefined ? input.providers : environmentProviders(), input.requestId);
  if (!providers.length) return fallbackCompletion(input.messages);
  let lastError: unknown;
  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex];
    const candidates = await modelCandidates(provider, input.model, input.settings);
    for (let modelIndex = 0; modelIndex < candidates.length; modelIndex += 1) {
      const model = candidates[modelIndex]; const startedAt = Date.now();
      const canReserve = input.store && typeof input.store.reserveAiProviderCapacity === "function" && typeof input.store.finalizeAiProviderReservation === "function" && typeof input.store.recordAiProviderAttempt === "function";
      const reservation = canReserve && input.requestId ? await input.store!.reserveAiProviderCapacity({ providerId: provider.id, requestId: `${input.requestId}:${provider.id}:${providerIndex}:${modelIndex}`, estimatedTokens: estimateTokens(input.messages) + 512 }) : undefined;
      if (canReserve && input.requestId && !reservation) { console.info("[Gbolix ai-provider] capacity_unavailable", JSON.stringify({ providerId: provider.id, model })); continue; }
      try {
        const completion = provider.adapter === "gemini" ? await completeWithGemini(provider, input, model) : await completeWithOpenAI(provider, input, model);
        if (reservation) await input.store!.finalizeAiProviderReservation(reservation.id, "committed", completion.inputTokens + completion.outputTokens);
        if (canReserve) await input.store!.recordAiProviderAttempt({ providerId: provider.id, model, requestId: input.requestId, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, latencyMs: Date.now() - startedAt, success: true });
        if (providerIndex > 0 || modelIndex > 0) console.info("[Gbolix ai-provider] fallback_succeeded", JSON.stringify({ providerId: provider.id, model, providerAttempt: providerIndex + 1, modelAttempt: modelIndex + 1 }));
        return completion;
      } catch (error) {
        if (reservation) await input.store!.finalizeAiProviderReservation(reservation.id, "released");
        if (canReserve) { const metadata = error as ProviderFailureMetadata; await input.store!.recordAiProviderAttempt({ providerId: provider.id, model, requestId: input.requestId, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt, success: false, httpStatus: metadata.httpStatus, rateLimited: metadata.rateLimited, quotaError: metadata.quotaError, retryAfterMs: metadata.retryAfterMs, errorCode: metadata.errorCode }); }
        lastError = error;
        console.error("[Gbolix ai-provider] fallback_attempt_failed", JSON.stringify({ providerId: provider.id, model, providerAttempt: providerIndex + 1, modelAttempt: modelIndex + 1, hasNextModel: modelIndex < candidates.length - 1, hasNextProvider: providerIndex < providers.length - 1, error: error instanceof Error ? error.message : String(error) }));
        if (!(input.settings?.fallbackEnabled ?? config.aiFallbackEnabled) || provider.fallbackEnabled === false) break;
      }
    }
    if (!(input.settings?.fallbackEnabled ?? config.aiFallbackEnabled) || provider.fallbackEnabled === false) break;
  }
  if (!lastError) return fallbackCompletion(input.messages);
  throw new Error(publicAIError(lastError));
}

function estimateTokens(messages: ChatMessage[]): number { return Math.max(1, Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4)); }

async function completeWithOpenAI(provider: AiProviderRuntime, input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[] }, model: string): Promise<Completion> {
  let response: Response;
  try { response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify({ model, messages: input.messages, tools: input.tools?.length ? input.tools : undefined, tool_choice: input.tools?.length ? "auto" : undefined, temperature: 0.3 }) }); }
  catch (error) { throw providerFailure(provider, error); }
  if (!response.ok) { const body = await response.text().catch(() => "response body unavailable"); throw providerFailure(provider, `HTTP ${response.status}: ${body}`, failureMetadata(response.status, body, response.headers)); }
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
  if (!response.ok) { const body = await response.text().catch(() => "response body unavailable"); throw providerFailure(provider, `HTTP ${response.status}: ${body}`, failureMetadata(response.status, body, response.headers)); }
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
