import { config } from "./config.js";
import type { AiProviderSettings, AiProviderId } from "./types.js";
import { loadProviderModels } from "./aiCatalog.js";

export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string };
export type ToolDefinition = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ToolCall = { id: string; function: { name: string; arguments: string } };
export type Completion = { content: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number; provider: string; model: string };

type SupportedProvider = "gemini" | "openai";

export const PUBLIC_AI_ERROR = "The agent could not generate a response right now. Please try again later.";
export function publicAIError(_error: unknown): string { return PUBLIC_AI_ERROR; }

function redacted(value: unknown): string {
  return String(value)
    .replace(/([?&](?:key|api[_-]?key|token|authorization)=)[^&\s]*/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .slice(0, 4000);
}

function providerFailure(provider: SupportedProvider, detail: unknown): Error {
  console.error("[Gbolix ai-provider] request_failed", JSON.stringify({ provider, detail: redacted(detail) }));
  return new Error(PUBLIC_AI_ERROR);
}

function providerOrder(settings?: AiProviderSettings): SupportedProvider[] {
  const configured = settings?.providerOrder?.length ? settings.providerOrder : config.aiProviderOrder.length ? config.aiProviderOrder : [config.aiProvider, config.aiProvider === "gemini" ? "openai" : "gemini"];
  return [...new Set(configured.map((item) => item.toLowerCase()).filter((item): item is SupportedProvider => item === "gemini" || item === "openai"))];
}

function hasCredentials(provider: SupportedProvider): boolean {
  return provider === "gemini" ? Boolean(config.geminiApiKey) : Boolean(config.openAiApiKey);
}

const liveModelCache = new Map<AiProviderId, { checkedAt: number; models: string[] }>();
async function liveModels(provider: SupportedProvider): Promise<string[] | undefined> { const cached = liveModelCache.get(provider); if (cached && Date.now() - cached.checkedAt < 5 * 60 * 1000) return cached.models; try { const models = await loadProviderModels(provider); const ids = models.filter((item) => item.live && !item.deprecated).map((item) => item.id); liveModelCache.set(provider, { checkedAt: Date.now(), models: ids }); return ids; } catch (error) { console.error("[Gbolix ai-provider] live_model_check_failed", JSON.stringify({ provider, error: error instanceof Error ? error.message : String(error) })); return undefined; } }
async function modelCandidates(provider: SupportedProvider, requested: string, settings?: AiProviderSettings): Promise<string[]> {
  const selected = settings?.models?.[provider];
  const fallback = provider === "gemini" ? (requested.startsWith("gemini-") ? requested : config.geminiModel) : (requested.startsWith("gemini-") ? config.openAiModel : requested || config.openAiModel);
  if (settings?.autoUpdateModels !== false) { const live = await liveModels(provider); if (live?.length) return [...new Set([selected, fallback, ...live].filter((item): item is string => Boolean(item)).filter((item) => live.includes(item)))]; }
  return [selected || fallback];
}

export async function complete(input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[]; settings?: AiProviderSettings }): Promise<Completion> {
  const providers = providerOrder(input.settings).filter(hasCredentials);
  if (!providers.length) return fallbackCompletion(input.messages);

  let lastError: unknown;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const candidates = await modelCandidates(provider, input.model, input.settings);
    for (let modelIndex = 0; modelIndex < candidates.length; modelIndex += 1) {
      const selectedModel = candidates[modelIndex];
      try {
        const completion = provider === "gemini" ? await completeWithGemini(input, selectedModel) : await completeWithOpenAI(input, selectedModel);
        if (index > 0 || modelIndex > 0) console.info("[Gbolix ai-provider] fallback_succeeded", JSON.stringify({ provider, model: selectedModel, attemptedProviders: providers.slice(0, index + 1), attemptedModelCount: modelIndex + 1 }));
        return completion;
      } catch (error) {
        lastError = error;
        console.error("[Gbolix ai-provider] fallback_attempt_failed", JSON.stringify({ provider, model: selectedModel, providerAttempt: index + 1, modelAttempt: modelIndex + 1, hasNextModel: modelIndex < candidates.length - 1, hasNextProvider: index < providers.length - 1, error: error instanceof Error ? error.message : String(error) }));
        if (!(input.settings?.fallbackEnabled ?? config.aiFallbackEnabled)) break;
      }
    }
    if (!(input.settings?.fallbackEnabled ?? config.aiFallbackEnabled)) break;
  }

  if (!lastError) return fallbackCompletion(input.messages);
  throw new Error(publicAIError(lastError));
}

async function completeWithOpenAI(input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[] }, model: string): Promise<Completion> {
  let response: Response;
  try {
    response = await fetch(`${config.openAiBaseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openAiApiKey}` }, body: JSON.stringify({ model, messages: input.messages, tools: input.tools?.length ? input.tools : undefined, tool_choice: input.tools?.length ? "auto" : undefined, temperature: 0.3 }) });
  } catch (error) { throw providerFailure("openai", error); }
  if (!response.ok) throw providerFailure("openai", `HTTP ${response.status}: ${await response.text().catch(() => "response body unavailable")}`);
  let data: any;
  try { data = await response.json(); } catch (error) { throw providerFailure("openai", error); }
  const message = data.choices?.[0]?.message;
  if (!message) throw providerFailure("openai", "provider returned no message");
  return { content: typeof message.content === "string" ? message.content : "", toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [], inputTokens: Number(data.usage?.prompt_tokens ?? 0), outputTokens: Number(data.usage?.completion_tokens ?? 0), provider: "openai", model };
}

async function completeWithGemini(input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[] }, model: string): Promise<Completion> {
  const system = input.messages.find((message) => message.role === "system")?.content;
  const contents = input.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.role === "tool" ? `Tool result (${message.name ?? "tool"}): ${message.content}` : message.content }] }));
  const body: Record<string, unknown> = { contents, generationConfig: { temperature: 0.3 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (input.tools?.length) body.tools = [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }];
  let response: Response;
  try {
    response = await fetch(`${config.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey ?? "")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) { throw providerFailure("gemini", error); }
  if (!response.ok) throw providerFailure("gemini", `HTTP ${response.status}: ${await response.text().catch(() => "response body unavailable")}`);
  let data: any;
  try { data = await response.json(); } catch (error) { throw providerFailure("gemini", error); }
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const content = parts.filter((part: any) => typeof part.text === "string").map((part: any) => part.text).join("\n");
  const toolCalls = parts.filter((part: any) => part.functionCall?.name).map((part: any, index: number) => ({ id: `ai_call_${index}`, function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } }));
  if (!content && !toolCalls.length) throw providerFailure("gemini", "provider returned no message");
  return { content, toolCalls, inputTokens: Number(data.usageMetadata?.promptTokenCount ?? 0), outputTokens: Number(data.usageMetadata?.candidatesTokenCount ?? 0), provider: "gemini", model };
}

function fallbackCompletion(messages: ChatMessage[]): Completion {
  const last = [...messages].reverse().find((item) => item.role === "user")?.content ?? "";
  const context = messages.find((item) => item.role === "system")?.content ?? "";
  const wantsHandoff = /human|person|agent|representative|complaint/i.test(last);
  const response = wantsHandoff ? "I’ll connect you with a member of the team so they can help you directly." : context.includes("Knowledge:") ? `Based on the business information I have, here is what I can share: ${context.split("Knowledge:")[1]?.slice(0, 220).trim() || "I’m ready to help with your request."}` : `Thanks for reaching out. I’m ready to help with: ${last.slice(0, 180)}.`;
  return { content: response, toolCalls: [], inputTokens: Math.ceil(last.length / 4), outputTokens: Math.ceil(response.length / 4), provider: "local_fallback", model: "fallback" };
}
