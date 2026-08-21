import { config } from "./config.js";

export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string };
export type ToolDefinition = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ToolCall = { id: string; function: { name: string; arguments: string } };
export type Completion = { content: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number };

export async function complete(input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[] }): Promise<Completion> {
  if (config.aiProvider.toLowerCase() === "gemini") return completeWithGemini(input);
  if (!config.openAiApiKey) return fallbackCompletion(input.messages);
  const response = await fetch(`${config.openAiBaseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openAiApiKey}` }, body: JSON.stringify({ model: input.model || config.openAiModel, messages: input.messages, tools: input.tools?.length ? input.tools : undefined, tool_choice: input.tools?.length ? "auto" : undefined, temperature: 0.3 }) });
  if (!response.ok) throw new Error(`AI provider returned ${response.status}: ${await response.text()}`);
  const data = await response.json() as any;
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("AI provider returned no message.");
  return { content: typeof message.content === "string" ? message.content : "", toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [], inputTokens: Number(data.usage?.prompt_tokens ?? 0), outputTokens: Number(data.usage?.completion_tokens ?? 0) };
}

async function completeWithGemini(input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[] }): Promise<Completion> {
  if (!config.geminiApiKey) return fallbackCompletion(input.messages);
  const system = input.messages.find((message) => message.role === "system")?.content;
  const contents = input.messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.role === "tool" ? `Tool result (${message.name ?? "tool"}): ${message.content}` : message.content }] }));
  const model = input.model && input.model.startsWith("gemini-") ? input.model : config.geminiModel;
  const body: Record<string, unknown> = { contents, generationConfig: { temperature: 0.3 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (input.tools?.length) body.tools = [{ functionDeclarations: input.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }];
  const response = await fetch(`${config.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Gemini provider returned ${response.status}: ${await response.text()}`);
  const data = await response.json() as any;
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const content = parts.filter((part: any) => typeof part.text === "string").map((part: any) => part.text).join("\n");
  const toolCalls = parts.filter((part: any) => part.functionCall?.name).map((part: any, index: number) => ({ id: `gemini_call_${index}`, function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } }));
  if (!content && !toolCalls.length) throw new Error("Gemini provider returned no message.");
  return { content, toolCalls, inputTokens: Number(data.usageMetadata?.promptTokenCount ?? 0), outputTokens: Number(data.usageMetadata?.candidatesTokenCount ?? 0) };
}

function fallbackCompletion(messages: ChatMessage[]): Completion {
  const last = [...messages].reverse().find((item) => item.role === "user")?.content ?? "";
  const context = messages.find((item) => item.role === "system")?.content ?? "";
  const wantsHandoff = /human|person|agent|representative|complaint/i.test(last);
  const response = wantsHandoff ? "I’ll connect you with a member of the team so they can help you directly." : context.includes("Knowledge:") ? `Based on the business information I have, here is what I can share: ${context.split("Knowledge:")[1]?.slice(0, 220).trim() || "I’m ready to help with your request."}` : `Thanks for reaching out. I’m ready to help with: ${last.slice(0, 180)}.`;
  return { content: response, toolCalls: [], inputTokens: Math.ceil(last.length / 4), outputTokens: Math.ceil(response.length / 4) };
}
