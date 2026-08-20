import crypto from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";
import type {
  Agent,
  ApiKeyRecord,
  Conversation,
  ConversationStatus,
  Deployment,
  KnowledgeSource,
  Message,
  Store,
  UsageEvent,
} from "./types.js";

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;

export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gbolix_agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL,
      tone TEXT NOT NULL DEFAULT 'warm, concise, and helpful',
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      welcome_message TEXT NOT NULL DEFAULT 'Hi! How can I help you today?',
      enabled_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS gbolix_agents_workspace_idx ON gbolix_agents(workspace_id);
    CREATE TABLE IF NOT EXISTS gbolix_knowledge (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES gbolix_agents(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'text',
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS gbolix_knowledge_agent_idx ON gbolix_knowledge(agent_id, workspace_id);
    CREATE TABLE IF NOT EXISTS gbolix_conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES gbolix_agents(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      visitor_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS gbolix_conversations_agent_idx ON gbolix_conversations(agent_id, workspace_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS gbolix_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES gbolix_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS gbolix_messages_conversation_idx ON gbolix_messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS gbolix_deployments (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES gbolix_agents(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      allowed_origin TEXT,
      token_prefix TEXT NOT NULL,
      public_token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS gbolix_deployments_token_idx ON gbolix_deployments(public_token_hash);
    CREATE TABLE IF NOT EXISTS gbolix_api_keys (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES gbolix_agents(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS gbolix_usage_events (
      request_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES gbolix_agents(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      channel TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS gbolix_usage_workspace_idx ON gbolix_usage_events(workspace_id, created_at DESC);
  `);
}

class MemoryStore implements Store {
  private agents = new Map<string, Agent>();
  private knowledge = new Map<string, KnowledgeSource>();
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, Message>();
  private deployments = new Map<string, Deployment & { tokenHash: string }>();
  private apiKeys = new Map<string, ApiKeyRecord>();
  private usage = new Map<string, UsageEvent>();

  async listAgents(workspaceId: string) { return [...this.agents.values()].filter((item) => item.workspaceId === workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async getAgent(agentId: string) { return this.agents.get(agentId); }
  async createAgent(input: Omit<Agent, "id" | "createdAt" | "updatedAt">) { const item = { ...input, id: id("agent"), createdAt: now(), updatedAt: now() }; this.agents.set(item.id, item); return item; }
  async updateAgent(agentId: string, workspaceId: string, patch: Partial<Pick<Agent, "name" | "description" | "instructions" | "tone" | "model" | "status" | "welcomeMessage" | "enabledTools">>) { const current = this.agents.get(agentId); if (!current || current.workspaceId !== workspaceId) return undefined; const item = { ...current, ...patch, updatedAt: now() }; this.agents.set(agentId, item); return item; }
  async listKnowledge(agentId: string, workspaceId: string) { return [...this.knowledge.values()].filter((item) => item.agentId === agentId && item.status === "ready" && this.agents.get(agentId)?.workspaceId === workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async addKnowledge(input: Omit<KnowledgeSource, "id" | "createdAt" | "updatedAt">) { const item = { ...input, id: id("know"), createdAt: now(), updatedAt: now() }; this.knowledge.set(item.id, item); return item; }
  async deleteKnowledge(knowledgeId: string, agentId: string, workspaceId: string) { const item = this.knowledge.get(knowledgeId); if (!item || item.agentId !== agentId || this.agents.get(agentId)?.workspaceId !== workspaceId) return false; this.knowledge.delete(knowledgeId); return true; }
  async getConversation(conversationId: string, workspaceId: string) { const item = this.conversations.get(conversationId); return item?.workspaceId === workspaceId ? item : undefined; }
  async listConversations(agentId: string, workspaceId: string) { return [...this.conversations.values()].filter((item) => item.agentId === agentId && item.workspaceId === workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async createConversation(input: Omit<Conversation, "id" | "createdAt" | "updatedAt">) { const item = { ...input, id: id("conv"), createdAt: now(), updatedAt: now() }; this.conversations.set(item.id, item); return item; }
  async touchConversation(conversationId: string, status?: ConversationStatus) { const item = this.conversations.get(conversationId); if (item) this.conversations.set(conversationId, { ...item, ...(status ? { status } : {}), updatedAt: now() }); }
  async listMessages(conversationId: string) { return [...this.messages.values()].filter((item) => item.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async addMessage(input: Omit<Message, "id" | "createdAt">) { const item = { ...input, id: id("msg"), createdAt: now() }; this.messages.set(item.id, item); return item; }
  async createDeployment(input: Omit<Deployment, "id" | "createdAt" | "updatedAt">) { const raw = crypto.randomBytes(24).toString("base64url"); const item = { ...input, id: id("dep"), tokenPrefix: `gblx_${raw.slice(0, 8)}`, tokenHash: hash(raw), createdAt: now(), updatedAt: now() }; this.deployments.set(item.id, item); const { tokenHash: _tokenHash, ...deployment } = item; return { ...deployment, plaintextToken: raw }; }
  async listDeployments(agentId: string, workspaceId: string) { return [...this.deployments.values()].filter((item) => item.agentId === agentId && item.workspaceId === workspaceId).map(({ tokenHash: _tokenHash, ...item }) => item); }
  async getDeploymentByToken(token: string) { const match = [...this.deployments.values()].find((item) => item.tokenHash === hash(token) && item.status === "active"); if (!match) return undefined; const { tokenHash: _tokenHash, ...deployment } = match; const agent = this.agents.get(match.agentId); return agent ? { deployment, agent } : undefined; }
  async revokeDeployment(deploymentId: string, agentId: string, workspaceId: string) { const item = this.deployments.get(deploymentId); if (!item || item.agentId !== agentId || item.workspaceId !== workspaceId) return false; this.deployments.set(deploymentId, { ...item, status: "revoked", updatedAt: now() }); return true; }
  async createApiKey(input: Omit<ApiKeyRecord, "id" | "createdAt">) { const item = { ...input, id: id("key"), createdAt: now() }; this.apiKeys.set(item.id, item); return item; }
  async getApiKeyByHash(keyHash: string) { const item = [...this.apiKeys.values()].find((value) => value.keyHash === keyHash && value.status === "active"); if (item) item.lastUsedAt = now(); return item; }
  async listApiKeys(agentId: string, workspaceId: string) { return [...this.apiKeys.values()].filter((item) => item.agentId === agentId && item.workspaceId === workspaceId).map((item) => ({ ...item, keyHash: "" })); }
  async addUsageEvent(event: UsageEvent) { const existing = this.usage.get(event.requestId); if (existing) return existing; this.usage.set(event.requestId, event); return event; }
  async listUsage(agentId: string, workspaceId: string, limit: number) { return [...this.usage.values()].filter((item) => item.agentId === agentId && item.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit); }
  async adminOverview() { const events = [...this.usage.values()]; return { customers: new Set([...this.agents.values()].map((item) => item.workspaceId)).size, agents: this.agents.size, responses: events.filter((item) => item.status === "completed").length, creditsUsed: events.reduce((sum, item) => sum + item.credits, 0), deployments: [...this.deployments.values()].filter((item) => item.status === "active").length }; }
  async adminCustomers(limit: number) { const ids = new Set([...this.agents.values()].map((item) => item.workspaceId)); return [...ids].slice(0, limit).map((workspaceId) => { const agents = [...this.agents.values()].filter((item) => item.workspaceId === workspaceId); const events = [...this.usage.values()].filter((item) => item.workspaceId === workspaceId); return { workspaceId, agents: agents.length, responses: events.filter((item) => item.status === "completed").length, creditsUsed: events.reduce((sum, item) => sum + item.credits, 0) }; }); }
}

class PostgresStore implements Store {
  constructor(private readonly pool: Pool) {}
  async listAgents(workspaceId: string) { const result = await this.pool.query("SELECT * FROM gbolix_agents WHERE workspace_id = $1 ORDER BY updated_at DESC", [workspaceId]); return result.rows.map((row) => agentRow(row)); }
  async getAgent(agentId: string) { const result = await this.pool.query("SELECT * FROM gbolix_agents WHERE id = $1 LIMIT 1", [agentId]); return result.rows[0] ? agentRow(result.rows[0]) : undefined; }
  async createAgent(input: Omit<Agent, "id" | "createdAt" | "updatedAt">) { const result = await this.pool.query("INSERT INTO gbolix_agents (id, workspace_id, name, description, instructions, tone, model, status, welcome_message, enabled_tools) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *", [id("agent"), input.workspaceId, input.name, input.description, input.instructions, input.tone, input.model, input.status, input.welcomeMessage, JSON.stringify(input.enabledTools)]); return agentRow(result.rows[0]); }
  async updateAgent(agentId: string, workspaceId: string, patch: Partial<Pick<Agent, "name" | "description" | "instructions" | "tone" | "model" | "status" | "welcomeMessage" | "enabledTools">>) { const current = await this.getAgent(agentId); if (!current || current.workspaceId !== workspaceId) return undefined; const next = { ...current, ...patch }; const result = await this.pool.query("UPDATE gbolix_agents SET name=$1, description=$2, instructions=$3, tone=$4, model=$5, status=$6, welcome_message=$7, enabled_tools=$8, updated_at=NOW() WHERE id=$9 AND workspace_id=$10 RETURNING *", [next.name, next.description, next.instructions, next.tone, next.model, next.status, next.welcomeMessage, JSON.stringify(next.enabledTools), agentId, workspaceId]); return result.rows[0] ? agentRow(result.rows[0]) : undefined; }
  async listKnowledge(agentId: string, workspaceId: string) { const result = await this.pool.query("SELECT * FROM gbolix_knowledge WHERE agent_id=$1 AND workspace_id=$2 AND status='ready' ORDER BY updated_at DESC", [agentId, workspaceId]); return result.rows.map(knowledgeRow); }
  async addKnowledge(input: Omit<KnowledgeSource, "id" | "createdAt" | "updatedAt">) { const result = await this.pool.query("INSERT INTO gbolix_knowledge (id,agent_id,workspace_id,title,content,source_type,status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [id("know"), input.agentId, input.workspaceId, input.title, input.content, input.sourceType, input.status]); return knowledgeRow(result.rows[0]); }
  async deleteKnowledge(knowledgeId: string, agentId: string, workspaceId: string) { const result = await this.pool.query("DELETE FROM gbolix_knowledge WHERE id=$1 AND agent_id=$2 AND workspace_id=$3", [knowledgeId, agentId, workspaceId]); return result.rowCount === 1; }
  async getConversation(conversationId: string, workspaceId: string) { const result = await this.pool.query("SELECT * FROM gbolix_conversations WHERE id=$1 AND workspace_id=$2 LIMIT 1", [conversationId, workspaceId]); return result.rows[0] ? conversationRow(result.rows[0]) : undefined; }
  async listConversations(agentId: string, workspaceId: string) { const result = await this.pool.query("SELECT * FROM gbolix_conversations WHERE agent_id=$1 AND workspace_id=$2 ORDER BY updated_at DESC", [agentId, workspaceId]); return result.rows.map(conversationRow); }
  async createConversation(input: Omit<Conversation, "id" | "createdAt" | "updatedAt">) { const result = await this.pool.query("INSERT INTO gbolix_conversations (id,agent_id,workspace_id,channel,visitor_key,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [id("conv"), input.agentId, input.workspaceId, input.channel, input.visitorKey, input.status]); return conversationRow(result.rows[0]); }
  async touchConversation(conversationId: string, status?: ConversationStatus) { await this.pool.query("UPDATE gbolix_conversations SET status=COALESCE($1,status), updated_at=NOW() WHERE id=$2", [status ?? null, conversationId]); }
  async listMessages(conversationId: string) { const result = await this.pool.query("SELECT * FROM gbolix_messages WHERE conversation_id=$1 ORDER BY created_at ASC", [conversationId]); return result.rows.map(messageRow); }
  async addMessage(input: Omit<Message, "id" | "createdAt">) { const result = await this.pool.query("INSERT INTO gbolix_messages (id,conversation_id,role,content,tool_name) VALUES ($1,$2,$3,$4,$5) RETURNING *", [id("msg"), input.conversationId, input.role, input.content, input.toolName ?? null]); return messageRow(result.rows[0]); }
  async createDeployment(input: Omit<Deployment, "id" | "createdAt" | "updatedAt">) { const raw = crypto.randomBytes(24).toString("base64url"); const result = await this.pool.query("INSERT INTO gbolix_deployments (id,agent_id,workspace_id,channel,allowed_origin,token_prefix,public_token_hash,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [id("dep"), input.agentId, input.workspaceId, input.channel, input.allowedOrigin ?? null, `gblx_${raw.slice(0, 8)}`, hash(raw), input.status]); return { ...deploymentRow(result.rows[0]), plaintextToken: raw }; }
  async listDeployments(agentId: string, workspaceId: string) { const result = await this.pool.query("SELECT * FROM gbolix_deployments WHERE agent_id=$1 AND workspace_id=$2 ORDER BY created_at DESC", [agentId, workspaceId]); return result.rows.map((row) => deploymentRow(row)); }
  async getDeploymentByToken(token: string) { const result = await this.pool.query("SELECT d.*, a.* FROM gbolix_deployments d JOIN gbolix_agents a ON a.id=d.agent_id WHERE d.public_token_hash=$1 AND d.status='active' LIMIT 1", [hash(token)]); if (!result.rows[0]) return undefined; return { deployment: deploymentRow(result.rows[0], "d_"), agent: agentRow(result.rows[0], "a_") }; }
  async revokeDeployment(deploymentId: string, agentId: string, workspaceId: string) { const result = await this.pool.query("UPDATE gbolix_deployments SET status='revoked',updated_at=NOW() WHERE id=$1 AND agent_id=$2 AND workspace_id=$3", [deploymentId, agentId, workspaceId]); return result.rowCount === 1; }
  async createApiKey(input: Omit<ApiKeyRecord, "id" | "createdAt">) { const result = await this.pool.query("INSERT INTO gbolix_api_keys (id,agent_id,workspace_id,key_prefix,key_hash,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [id("key"), input.agentId, input.workspaceId, input.keyPrefix, input.keyHash, input.status]); return apiKeyRow(result.rows[0]); }
  async getApiKeyByHash(keyHash: string) { const result = await this.pool.query("UPDATE gbolix_api_keys SET last_used_at=NOW() WHERE key_hash=$1 AND status='active' RETURNING *", [keyHash]); return result.rows[0] ? apiKeyRow(result.rows[0]) : undefined; }
  async listApiKeys(agentId: string, workspaceId: string) { const result = await this.pool.query("SELECT * FROM gbolix_api_keys WHERE agent_id=$1 AND workspace_id=$2 ORDER BY created_at DESC", [agentId, workspaceId]); return result.rows.map((row) => ({ ...apiKeyRow(row), keyHash: "" })); }
  async addUsageEvent(event: UsageEvent) { const result = await this.pool.query("INSERT INTO gbolix_usage_events (request_id,workspace_id,agent_id,conversation_id,model,input_tokens,output_tokens,tool_calls,credits,status,channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING *", [event.requestId, event.workspaceId, event.agentId, event.conversationId, event.model, event.inputTokens, event.outputTokens, event.toolCalls, event.credits, event.status, event.channel]); return usageRow(result.rows[0]); }
  async listUsage(agentId: string, workspaceId: string, limit: number) { const result = await this.pool.query("SELECT * FROM gbolix_usage_events WHERE agent_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT $3", [agentId, workspaceId, limit]); return result.rows.map(usageRow); }
  async adminOverview() { const result = await this.pool.query("SELECT COUNT(DISTINCT workspace_id)::int AS customers, COUNT(DISTINCT agent_id)::int AS agents, COUNT(*) FILTER (WHERE status='completed')::int AS responses, COALESCE(SUM(credits),0)::int AS credits_used, (SELECT COUNT(*)::int FROM gbolix_deployments WHERE status='active') AS deployments FROM gbolix_usage_events"); return result.rows[0]; }
  async adminCustomers(limit: number) { const result = await this.pool.query("SELECT workspace_id, COUNT(DISTINCT agent_id)::int AS agents, COUNT(*) FILTER (WHERE status='completed')::int AS responses, COALESCE(SUM(credits),0)::int AS credits_used FROM gbolix_usage_events GROUP BY workspace_id ORDER BY responses DESC LIMIT $1", [limit]); return result.rows.map((row) => ({ workspaceId: row.workspace_id, agents: row.agents, responses: row.responses, creditsUsed: row.credits_used })); }
}

function hash(value: string) { return crypto.createHash("sha256").update(value).digest("hex"); }
function agentRow(row: any, prefix = "") : Agent { return { id: row[`${prefix}id`] ?? row.id, workspaceId: row[`${prefix}workspace_id`] ?? row.workspace_id, name: row[`${prefix}name`] ?? row.name, description: row[`${prefix}description`] ?? row.description, instructions: row[`${prefix}instructions`] ?? row.instructions, tone: row[`${prefix}tone`] ?? row.tone, model: row[`${prefix}model`] ?? row.model, status: row[`${prefix}status`] ?? row.status, welcomeMessage: row[`${prefix}welcome_message`] ?? row.welcome_message, enabledTools: row[`${prefix}enabled_tools`] ?? row.enabled_tools ?? [], createdAt: new Date(row[`${prefix}created_at`] ?? row.created_at).toISOString(), updatedAt: new Date(row[`${prefix}updated_at`] ?? row.updated_at).toISOString() }; }
function knowledgeRow(row: any): KnowledgeSource { return { id: row.id, agentId: row.agent_id, workspaceId: row.workspace_id, title: row.title, content: row.content, sourceType: row.source_type, status: row.status, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
function conversationRow(row: any): Conversation { return { id: row.id, agentId: row.agent_id, workspaceId: row.workspace_id, channel: row.channel, visitorKey: row.visitor_key, status: row.status, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
function messageRow(row: any): Message { return { id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, toolName: row.tool_name ?? undefined, createdAt: new Date(row.created_at).toISOString() }; }
function deploymentRow(row: any, prefix = ""): Deployment { return { id: row[`${prefix}id`] ?? row.id, agentId: row[`${prefix}agent_id`] ?? row.agent_id, workspaceId: row[`${prefix}workspace_id`] ?? row.workspace_id, channel: row[`${prefix}channel`] ?? row.channel, allowedOrigin: row[`${prefix}allowed_origin`] ?? row.allowed_origin ?? undefined, tokenPrefix: row[`${prefix}token_prefix`] ?? row.token_prefix, status: row[`${prefix}status`] ?? row.status, createdAt: new Date(row[`${prefix}created_at`] ?? row.created_at).toISOString(), updatedAt: new Date(row[`${prefix}updated_at`] ?? row.updated_at).toISOString() }; }
function apiKeyRow(row: any): ApiKeyRecord { return { id: row.id, agentId: row.agent_id, workspaceId: row.workspace_id, keyPrefix: row.key_prefix, keyHash: row.key_hash, status: row.status, createdAt: new Date(row.created_at).toISOString(), lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : undefined }; }
function usageRow(row: any): UsageEvent { return { requestId: row.request_id, workspaceId: row.workspace_id, agentId: row.agent_id, conversationId: row.conversation_id, model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens, toolCalls: row.tool_calls, credits: row.credits, status: row.status, channel: row.channel, createdAt: new Date(row.created_at).toISOString() }; }

export async function createStore(): Promise<Store> {
  if (!config.databaseUrl) return new MemoryStore();
  const pool = new Pool({ connectionString: config.databaseUrl, ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false } });
  await ensureSchema(pool);
  return new PostgresStore(pool);
}

export { hash };
