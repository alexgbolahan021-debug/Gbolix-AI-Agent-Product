import crypto from "node:crypto";
import { config } from "./config.js";
import { CreditError, CreditService } from "./credits.js";
import { complete, type ChatMessage } from "./provider.js";
import { executeTool, BUILTIN_TOOLS } from "./tools.js";
import type { AgentMessageInput, AgentMessageOutput, Identity, Store } from "./types.js";

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
      const knowledge = await this.store.listKnowledge(agent.id, identity.workspaceId);
      const history = await this.store.listMessages(currentConversation.id);
      const retrievedKnowledge = selectKnowledge(knowledge, input.message);
      const system = buildSystemPrompt(agent, retrievedKnowledge.map((item) => `### ${item.title}\n${item.content}`).join("\n\n"));
      const messages: ChatMessage[] = [{ role: "system", content: system }, ...history.slice(-24).map((item) => ({ role: item.role, content: item.content, ...(item.toolName ? { name: item.toolName } : {}) }))];
      const tools = agent.enabledTools.map((name) => BUILTIN_TOOLS[name]).filter(Boolean);
      let completion = await complete({ model: agent.model || config.defaultModel, messages, tools });
      let toolCalls = 0;
      let handoff = false;
      for (let round = 0; round < config.maxToolRounds && completion.toolCalls.length; round += 1) {
        toolCalls += completion.toolCalls.length;
        messages.push({ role: "assistant", content: completion.content || "" });
        for (const call of completion.toolCalls) {
          const result = await executeTool(call.function.name, call.function.arguments);
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
