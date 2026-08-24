import { config } from "./config.js";

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

function providerOrder(): SupportedProvider[] {
  const configured = config.aiProviderOrder.length ? config.aiProviderOrder : [config.aiProvider, config.aiProvider === "gemini" ? "openai" : "gemini"];
  return [...new Set(configured.map((item) => item.toLowerCase()).filter((item): item is SupportedProvider => item === "gemini" || item === "openai"))];
}

function hasCredentials(provider: SupportedProvider): boolean {
  return provider === "gemini" ? Boolean(config.geminiApiKey) : Boolean(config.openAiApiKey);
}

function modelFor(provider: SupportedProvider, requested: string): string {
  if (provider === "gemini") return requested.startsWith("gemini-") ? requested : config.geminiModel;
  return requested.startsWith("gemini-") ? config.openAiModel : requested || config.openAiModel;
}

export async function complete(input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[] }): Promise<Completion> {
  const providers = providerOrder().filter(hasCredentials);
  if (!providers.length) return fallbackCompletion(input.messages);

  let lastError: unknown;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      const completion = provider === "gemini" ? await completeWithGemini(input, modelFor(provider, input.model)) : await completeWithOpenAI(input, modelFor(provider, input.model));
      if (index > 0) console.info("[Gbolix ai-provider] fallback_succeeded", JSON.stringify({ provider, attemptedProviders: providers.slice(0, index + 1) }));
      return completion;
    } catch (error) {
      lastError = error;
      console.error("[Gbolix ai-provider] fallback_attempt_failed", JSON.stringify({ provider, attempt: index + 1, hasNextProvider: index < providers.length - 1, error: error instanceof Error ? error.message : String(error) }));
      if (!config.aiFallbackEnabled) break;
    }
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
