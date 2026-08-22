import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AgentRuntime } from "../src/runtime.js";
import { CreditService } from "../src/credits.js";

function makeFixture(level: 1 | 2 | 3, withConnection = false) {
  const agent = { id: `agent_${level}`, workspaceId: `workspace_${level}`, name: `Level ${level} test agent`, description: "", instructions: "Use connected tools only when explicitly requested.", tone: "concise", model: "gpt-5-mini", level, status: "active" as const, welcomeMessage: "Hello", enabledTools: level === 1 ? ["capture_contact"] : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const connection = { id: "conn_test", agentId: agent.id, workspaceId: agent.workspaceId, kind: "custom_api" as const, provider: "Local test endpoint", name: "Sample order status lookup", endpoint: "http://127.0.0.1:0", method: "GET" as const, authType: "none" as const, status: "connected" as const, permissions: ["read"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const messages: any[] = [];
  const store: any = {
    async getAgent(id: string) { return id === agent.id ? agent : undefined; },
    async listKnowledge() { return []; },
    async listConnections() { return withConnection ? [connection] : []; },
    async getConnection() { return withConnection ? connection : undefined; },
    async getConversation() { return undefined; },
    async createConversation(input: any) { return { ...input, id: `conversation_${level}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; },
    async listMessages() { return messages.slice(); },
    async addMessage(input: any) { const row = { ...input, id: `message_${messages.length + 1}`, createdAt: new Date().toISOString() }; messages.push(row); return row; },
    async touchConversation() {},
    async addUsageEvent(event: any) { return event; },
  };
  return { agent, connection, messages, store };
}

test("Level 1 does not execute actions even if a client sends an enabled tool", async () => {
  const fixture = makeFixture(1);
  const result = await new AgentRuntime(fixture.store, new CreditService()).run(fixture.agent.id, { workspaceId: fixture.agent.workspaceId, subject: "test", authType: "identity" }, { message: "Please call me back at test@example.com", channel: "playground" });
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.usage.credits, 1);
  assert.equal(fixture.messages.some((message) => message.role === "tool"), false);
});

test("Level 2 does not execute Custom API connections", async () => {
  const fixture = makeFixture(2, true);
  const result = await new AgentRuntime(fixture.store, new CreditService()).run(fixture.agent.id, { workspaceId: fixture.agent.workspaceId, subject: "test", authType: "identity" }, { message: "Please check the sample order status", channel: "playground" });
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.usage.credits, 1);
});

test("Level 3 invokes a connected Custom API and charges one credit", async () => {
  const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status: "ready", source: "local-test-endpoint" })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const fixture = makeFixture(3, true);
  fixture.connection.endpoint = `http://127.0.0.1:${address.port}/status`;
  const result = await new AgentRuntime(fixture.store, new CreditService()).run(fixture.agent.id, { workspaceId: fixture.agent.workspaceId, subject: "test", authType: "identity" }, { message: "Please check the sample order status", channel: "playground" });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.usage.credits, 1);
  assert.match(result.response, /status.*ready/);
  assert.equal(fixture.messages.filter((message) => message.role === "tool").length, 1);
});
