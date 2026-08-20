import { config } from "./config.js";

export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string };
export type ToolDefinition = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ToolCall = { id: string; function: { name: string; arguments: string } };
export type Completion = { content: string; toolCalls: ToolCall[]; inputTokens: number; outputTokens: number };

export async function complete(input: { model: string; messages: ChatMessage[]; tools?: ToolDefinition[] }): Promise<Completion> {
  if (!config.openAiApiKey) return fallbackCompletion(input.messages);
  const response = await fetch(`${config.openAiBaseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openAiApiKey}` }, body: JSON.stringify({ model: input.model || config.defaultModel, messages: input.messages, tools: input.tools?.length ? input.tools : undefined, tool_choice: input.tools?.length ? "auto" : undefined, temperature: 0.3 }) });
  if (!response.ok) throw new Error(`AI provider returned ${response.status}: ${await response.text()}`);
  const data = await response.json() as any;
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("AI provider returned no message.");
  return { content: typeof message.content === "string" ? message.content : "", toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [], inputTokens: Number(data.usage?.prompt_tokens ?? 0), outputTokens: Number(data.usage?.completion_tokens ?? 0) };
}

function fallbackCompletion(messages: ChatMessage[]): Completion {
  const last = [...messages].reverse().find((item) => item.role === "user")?.content ?? "";
  const context = messages.find((item) => item.role === "system")?.content ?? "";
  const wantsHandoff = /human|person|agent|representative|complaint/i.test(last);
  const response = wantsHandoff ? "I’ll connect you with a member of the team so they can help you directly." : context.includes("Knowledge:") ? `Based on the business information I have, here is what I can share: ${context.split("Knowledge:")[1]?.slice(0, 220).trim() || "I’m ready to help with your request."}` : `Thanks for reaching out. I’m ready to help with: ${last.slice(0, 180)}.`;
  return { content: response, toolCalls: [], inputTokens: Math.ceil(last.length / 4), outputTokens: Math.ceil(response.length / 4) };
}
