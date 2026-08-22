import crypto from "node:crypto";
import { config } from "./config.js";
import { CreditError, CreditService } from "./credits.js";
import { complete, type ChatMessage, type ToolDefinition } from "./provider.js";
import { executeTool, BUILTIN_TOOLS } from "./tools.js";
import type { AgentConnection, AgentMessageInput, AgentMessageOutput, Identity, Store, StoredAgentConnection } from "./types.js";

export class AgentRuntime {
  constructor(private readonly store: Store, private readonly credits: CreditService) {}

  async run(agentId: string, identity: Identity, input: AgentMessageInput): Promise<AgentMessageOutput> {
    const agent = await this.store.getAgent(agentId);
    if (!agent || agent.workspaceId !== identity.workspaceId) throw new Error("Agent not found.");
    if (agent.status === "paused" || agent.status === "disabled") throw new Error("This agent is not currently accepting messages.");
    if (!input.message.trim()) throw new Error("Message is required.");

    const requestId = `req_${crypto.randomBytes(12).toString("hex")}`;
    const channel = input.channel ?? (identity.authType === "deployment" ? "website" : "playground");
    const conversation = input.conversationId ? await this.store.getConversation(input.conversationId, identity.workspaceId) : undefined;
    if (input.conversationId && (!conversation || conversation.agentId !== agent.id)) throw new Error("Conversation not found.");
    const currentConversation = conversation ?? await this.store.createConversation({ agentId: agent.id, workspaceId: identity.workspaceId, channel, visitorKey: input.visitorKey ?? identity.subject, status: "open" });
    await this.store.addMessage({ conversationId: currentConversation.id, role: "user", content: input.message });

    let authorization;
    try { authorization = await this.credits.reserve({ requestId, workspaceId: identity.workspaceId, agentId: agent.id, maximumCredits: 1 }); } catch (error) {
      if (error instanceof CreditError && error.code === "INSUFFICIENT_CREDITS") {
        await this.store.addUsageEvent({ requestId, workspaceId: identity.workspaceId, agentId: agent.id, conversationId: currentConversation.id, model: agent.model, inputTokens: 0, outputTokens: 0, toolCalls: 0, credits: 0, status: "insufficient_credits", channel, createdAt: new Date().toISOString() });
      }
      throw error;
    }

    try {
      const knowledge = agent.level >= 2 ? await this.store.listKnowledge(agent.id, identity.workspaceId) : [];
      const history = await this.store.listMessages(currentConversation.id);
      const retrievedKnowledge = selectKnowledge(knowledge, input.message);
      const system = buildSystemPrompt(agent, retrievedKnowledge.map((item) => `### ${item.title}\n${item.content}`).join("\n\n"));
      const messages: ChatMessage[] = [{ role: "system", content: system }, ...history.slice(-24).map((item) => ({ role: item.role, content: item.content, ...(item.toolName ? { name: item.toolName } : {}) }))];
      const connections = agent.level >= 3 ? await this.store.listConnections(agent.id, identity.workspaceId) : [];
      const customConnections = connections.filter((connection) => connection.kind === "custom_api");
      const customToolMap = new Map(customConnections.map((connection) => [customToolName(connection), connection]));
      const tools: ToolDefinition[] = agent.level >= 3 ? [...agent.enabledTools.map((name) => BUILTIN_TOOLS[name]).filter(Boolean), ...customConnections.map(customConnectionTool)] : [];
      const explicitContact = agent.level >= 3 && agent.enabledTools.includes("capture_contact") ? extractExplicitContactRequest(input.message) : undefined;
      const explicitCustomConnection = !explicitContact ? customConnections.find((connection) => explicitCustomRequest(input.message, connection)) : undefined;
      let completion;
      let toolCalls = 0;
      let handoff = false;
      if (explicitContact) {
        const result = await executeTool("capture_contact", JSON.stringify(explicitContact));
        toolCalls = 1;
        messages.push({ role: "assistant", content: "" });
        messages.push({ role: "tool", content: result.output, tool_call_id: `direct_capture_${requestId}`, name: "capture_contact" });
        await this.store.addMessage({ conversationId: currentConversation.id, role: "tool", content: result.output, toolName: "capture_contact" });
        completion = { content: `Thanks ${explicitContact.name}. I’ve recorded your contact details for a callback from the Gbolix team.`, toolCalls: [], inputTokens: 0, outputTokens: 0 };
      } else if (explicitCustomConnection) {
        const result = await executeCustomApiConnection(explicitCustomConnection, "{}");
        toolCalls = 1;
        messages.push({ role: "assistant", content: "" });
        messages.push({ role: "tool", content: result.output, tool_call_id: `direct_custom_api_${requestId}`, name: customToolName(explicitCustomConnection) });
        await this.store.addMessage({ conversationId: currentConversation.id, role: "tool", content: result.output, toolName: customToolName(explicitCustomConnection) });
        completion = { content: `I checked ${explicitCustomConnection.name}. The connected system returned: ${result.output.slice(0, 1200)}`, toolCalls: [], inputTokens: 0, outputTokens: 0 };
      } else {
        completion = await complete({ model: agent.model || config.defaultModel, messages, tools });
      }
      for (let round = 0; round < config.maxToolRounds && completion.toolCalls.length; round += 1) {
        toolCalls += completion.toolCalls.length;
        messages.push({ role: "assistant", content: completion.content || "" });
        for (const call of completion.toolCalls) {
          const customConnection = customToolMap.get(call.function.name);
          const result = customConnection ? await executeCustomApiConnection(customConnection, call.function.arguments) : await executeTool(call.function.name, call.function.arguments);
          handoff = handoff || result.handoff;
          messages.push({ role: "tool", content: result.output, tool_call_id: call.id, name: call.function.name });
          await this.store.addMessage({ conversationId: currentConversation.id, role: "tool", content: result.output, toolName: call.function.name });
        }
        completion = await complete({ model: agent.model || config.defaultModel, messages, tools });
      }
      const response = completion.content.trim() || "I’m sorry, I couldn’t complete that request. A member of the team can help you next.";
      handoff = handoff || /connect you with|member of the team|human|representative/i.test(response);
      if (handoff) await this.store.touchConversation(currentConversation.id, "handoff");
      await this.store.addMessage({ conversationId: currentConversation.id, role: "assistant", content: response });
      await this.store.touchConversation(currentConversation.id);
      await this.credits.finalize(authorization, { requestId, workspaceId: identity.workspaceId, agentId: agent.id, conversationId: currentConversation.id, credits: 1, model: agent.model || config.defaultModel, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, toolCalls });
      const usage = await this.store.addUsageEvent({ requestId, workspaceId: identity.workspaceId, agentId: agent.id, conversationId: currentConversation.id, model: agent.model || config.defaultModel, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, toolCalls, credits: 1, status: "completed", channel, createdAt: new Date().toISOString() });
      return { requestId, conversationId: currentConversation.id, response, agent: { id: agent.id, name: agent.name, welcomeMessage: agent.welcomeMessage }, usage: { credits: usage.credits, toolCalls: usage.toolCalls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, handoff };
    } catch (error) {
      await this.credits.release(authorization);
      await this.store.addUsageEvent({ requestId, workspaceId: identity.workspaceId, agentId: agent.id, conversationId: currentConversation.id, model: agent.model || config.defaultModel, inputTokens: 0, outputTokens: 0, toolCalls: 0, credits: 0, status: "failed", channel, createdAt: new Date().toISOString() });
      throw error;
    }
  }
}

function selectKnowledge<T extends { title: string; content: string }>(sources: T[], query: string) { const terms = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2)); if (!terms.size || sources.length <= 8) return sources.slice(0, 8); return sources.map((source) => ({ source, score: [...terms].reduce((score, term) => score + (source.title.toLowerCase().includes(term) ? 3 : 0) + (source.content.toLowerCase().includes(term) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score).slice(0, 8).map((item) => item.source); }

function buildSystemPrompt(agent: { name: string; instructions: string; tone: string; welcomeMessage: string }, knowledge: string): string {
  return [`You are ${agent.name}, a business AI agent powered by Gbolix.`, `Follow these business instructions exactly:\n${agent.instructions}`, `Use this tone: ${agent.tone}.`, "Never invent business facts. If the knowledge does not answer a question, say so and offer a human handoff.", "Only use tools that are explicitly enabled. Do not claim an action happened unless a tool result confirms it.", `If the visitor asks for a human, cannot be helped safely, or expresses a complaint, offer a human handoff.`, `Welcome message: ${agent.welcomeMessage}`, knowledge ? `Knowledge:\n${knowledge}` : "Knowledge: No business knowledge has been added yet."].join("\n\n");
}


function customToolName(connection: AgentConnection): string { return `custom_api_${connection.id.replace(/[^a-zA-Z0-9_]/g, "_")}`; }
function customConnectionTool(connection: AgentConnection): ToolDefinition { return { type: "function", function: { name: customToolName(connection), description: `Use the connected Custom API tool ${connection.name}. Only call it when the visitor explicitly asks for this check.`, parameters: { type: "object", properties: { parameters: { type: "object", additionalProperties: { type: "string" } }, body: { type: "object", additionalProperties: true } }, additionalProperties: false } } }; }
function explicitCustomRequest(message: string, connection: AgentConnection): boolean { const normalized = message.toLowerCase(); return normalized.includes("custom api") || normalized.includes(connection.name.toLowerCase()) || /\b(check|look up|fetch|query|call)\b/.test(normalized) && /\b(order|status|account|record|endpoint)\b/.test(normalized); }
async function executeCustomApiConnection(connection: StoredAgentConnection, rawArguments: string): Promise<{ output: string; handoff: boolean }> { let args: Record<string, unknown> = {}; try { args = JSON.parse(rawArguments) as Record<string, unknown>; } catch { return { output: "The Custom API input was invalid, so no request was made.", handoff: false }; } const target = new URL(connection.endpoint ?? ""); const parameters = args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters) ? args.parameters as Record<string, unknown> : {}; if (connection.method === "GET" || connection.method === "DELETE") Object.entries(parameters).forEach(([key, value]) => { if (typeof value === "string" && key.length <= 80) target.searchParams.set(key, value.slice(0, 300)); }); const headers: Record<string, string> = { accept: "application/json,text/plain", ...(connection.headers ?? {}) }; const secret = connection.encryptedSecret ? openSecret(connection.encryptedSecret) : undefined; if (secret && connection.authType === "bearer") headers.authorization = `Bearer ${secret}`; if (secret && connection.authType === "api_key") headers["x-api-key"] = secret; const init: RequestInit = { method: connection.method ?? "GET", headers, signal: AbortSignal.timeout(10000) }; if (init.method !== "GET" && init.method !== "DELETE") { headers["content-type"] = "application/json"; init.body = JSON.stringify(args.body && typeof args.body === "object" ? args.body : {}); } const response = await fetch(target, init); const text = (await response.text()).slice(0, 12000); if (!response.ok) return { output: JSON.stringify({ ok: false, status: response.status, error: "Connected API request failed", detail: text.slice(0, 500) }), handoff: false }; let data: unknown = text; try { data = JSON.parse(text); } catch { /* keep text */ } return { output: JSON.stringify({ ok: true, status: response.status, data }), handoff: false }; }
function openSecret(value: string): string { if (!config.connectionEncryptionKey) throw new Error("Connection encryption is not configured."); const [version, ivEncoded, tagEncoded, ciphertextEncoded] = value.split(":"); if (version !== "v1" || !ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error("Stored connection secret is invalid."); const key = crypto.createHash("sha256").update(config.connectionEncryptionKey).digest(); const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivEncoded, "base64url")); decipher.setAuthTag(Buffer.from(tagEncoded, "base64url")); return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64url")), decipher.final()]).toString("utf8"); }
function extractExplicitContactRequest(message: string): { name: string; email: string; phone: string; note: string } | undefined {
  const email = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const asksForFollowUp = /\b(callback|call me|follow[ -]?up|contact me|reach me|sales team|speak with sales)\b/i.test(message);
  if (!email || !asksForFollowUp) return undefined;
  const name = message.match(/\b(?:my name is|i am|i'm)\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,3})/i)?.[1]?.trim() || "Visitor";
  const phone = message.match(/(?:\+?\d[\d\s().-]{7,}\d)/)?.[0]?.trim() || "";
  return { name, email, phone, note: message.trim().slice(0, 240) };
}
