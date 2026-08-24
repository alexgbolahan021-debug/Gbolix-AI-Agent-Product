export type AgentStatus = "draft" | "active" | "paused" | "disabled";
export type ConversationStatus = "open" | "resolved" | "handoff";
export type MessageRole = "system" | "user" | "assistant" | "tool";

export type Identity = {
  subject: string;
  workspaceId: string;
  workspaceKey?: string;
  role?: string;
  email?: string;
  isAdmin?: boolean;
  authType: "identity" | "deployment" | "api-key" | "internal";
};

export type AgentLevel = 1 | 2 | 3;
export type AgentVersion = { id: string; agentId: string; workspaceId: string; version: number; config: Pick<Agent, "name" | "description" | "instructions" | "tone" | "model" | "status" | "welcomeMessage" | "enabledTools" | "level">; createdBy: string; createdAt: string };

export type Agent = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  tone: string;
  model: string;
  level: AgentLevel;
  status: AgentStatus;
  welcomeMessage: string;
  enabledTools: string[];
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeSource = {
  id: string;
  agentId: string;
  workspaceId: string;
  title: string;
  content: string;
  sourceType: "text" | "url" | "file";
  status: "ready" | "processing" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type Conversation = {
  id: string;
  agentId: string;
  workspaceId: string;
  channel: "playground" | "website" | "api" | "webhook";
  visitorKey: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  toolName?: string;
  createdAt: string;
};

export type Deployment = {
  id: string;
  agentId: string;
  workspaceId: string;
  channel: "website";
  allowedOrigin?: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
};

export type AgentConnection = {
  id: string;
  agentId: string;
  workspaceId: string;
  kind: "native" | "custom_api";
  provider: string;
  name: string;
  endpoint?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  authType?: "none" | "api_key" | "bearer";
  status: "connected" | "disconnected";
  permissions: string[];
  createdAt: string;
  updatedAt: string;
};

export type StoredAgentConnection = AgentConnection & { encryptedSecret?: string; headers?: Record<string, string>; parameters?: Record<string, string> };
export type EmailReplyMode = "off" | "draft" | "automatic";
export type EmailReplyScope = "agent_sent" | "matching_rules" | "both";
export type EmailSettings = { agentId: string; workspaceId: string; replyMode: EmailReplyMode; replyScope: EmailReplyScope; matchingQuery: string; updatedAt: string };
export type EmailCampaignStatus = "queued" | "running" | "paused" | "completed" | "failed";
export type EmailRowStatus = "queued" | "sent" | "failed" | "skipped";
export type EmailCampaign = { id: string; agentId: string; workspaceId: string; status: EmailCampaignStatus; subjectTemplate: string; bodyTemplate: string; messageMode: "shared" | "per_row"; totalRows: number; sentRows: number; failedRows: number; createdAt: string; updatedAt: string };
export type EmailCampaignRow = { id: string; campaignId: string; rowNumber: number; email: string; data: Record<string, string>; subject: string; body: string; status: EmailRowStatus; messageId?: string; threadId?: string; error?: string; createdAt: string; updatedAt: string };
export type EmailReplyEvent = { id: string; agentId: string; workspaceId: string; gmailMessageId: string; threadId: string; fromEmail?: string; subject?: string; receivedAt?: string; body: string; status: "pending" | "sent" | "ignored" | "failed"; replyBody?: string; replyMessageId?: string; error?: string; createdAt: string; updatedAt: string };

export type ApiKeyRecord = {
  id: string;
  agentId: string;
  workspaceId: string;
  keyPrefix: string;
  keyHash: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt?: string;
};

export type UsageEvent = {
  requestId: string;
  workspaceId: string;
  agentId: string;
  conversationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  credits: number;
  status: "completed" | "failed" | "insufficient_credits";
  channel: Conversation["channel"];
  createdAt: string;
};

export type AgentMessageInput = {
  message: string;
  conversationId?: string;
  visitorKey?: string;
  channel?: Conversation["channel"];
};

export type AgentMessageOutput = {
  requestId: string;
  conversationId: string;
  response: string;
  agent: Pick<Agent, "id" | "name" | "welcomeMessage">;
  usage: Pick<UsageEvent, "credits" | "toolCalls" | "inputTokens" | "outputTokens">;
  handoff: boolean;
};

export type Store = {
  listAgents(workspaceId: string): Promise<Agent[]>;
  createAgentVersion(input: Omit<AgentVersion, "id" | "createdAt">): Promise<AgentVersion>;
  listAgentVersions(agentId: string, workspaceId: string): Promise<AgentVersion[]>;
  restoreAgentVersion(versionId: string, agentId: string, workspaceId: string): Promise<Agent | undefined>;
  getAgent(agentId: string): Promise<Agent | undefined>;
  createAgent(input: Omit<Agent, "id" | "createdAt" | "updatedAt">): Promise<Agent>;
  updateAgent(agentId: string, workspaceId: string, patch: Partial<Pick<Agent, "name" | "description" | "instructions" | "tone" | "model" | "level" | "status" | "welcomeMessage" | "enabledTools">>): Promise<Agent | undefined>;
  listKnowledge(agentId: string, workspaceId: string): Promise<KnowledgeSource[]>;
  addKnowledge(input: Omit<KnowledgeSource, "id" | "createdAt" | "updatedAt">): Promise<KnowledgeSource>;
  deleteKnowledge(id: string, agentId: string, workspaceId: string): Promise<boolean>;
  getConversation(id: string, workspaceId: string): Promise<Conversation | undefined>;
  listConversations(agentId: string, workspaceId: string): Promise<Conversation[]>;
  createConversation(input: Omit<Conversation, "id" | "createdAt" | "updatedAt">): Promise<Conversation>;
  touchConversation(id: string, status?: ConversationStatus): Promise<void>;
  listMessages(conversationId: string): Promise<Message[]>;
  addMessage(input: Omit<Message, "id" | "createdAt">): Promise<Message>;
  createDeployment(input: Omit<Deployment, "id" | "createdAt" | "updatedAt">): Promise<Deployment & { plaintextToken?: string }>;
  listDeployments(agentId: string, workspaceId: string): Promise<Deployment[]>;
  getDeploymentByToken(token: string): Promise<{ deployment: Deployment; agent: Agent } | undefined>;
  revokeDeployment(id: string, agentId: string, workspaceId: string): Promise<boolean>;
  createApiKey(input: Omit<ApiKeyRecord, "id" | "createdAt">): Promise<ApiKeyRecord>;
  getApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | undefined>;
  listApiKeys(agentId: string, workspaceId: string): Promise<ApiKeyRecord[]>;
  revokeApiKey(id: string, agentId: string, workspaceId: string): Promise<boolean>;
  createConnection(input: { agentId: string; workspaceId: string; kind: AgentConnection["kind"]; provider: string; name: string; endpoint?: string; method?: AgentConnection["method"]; authType?: AgentConnection["authType"]; encryptedSecret?: string; headers?: Record<string, string>; parameters?: Record<string, string>; permissions: string[] }): Promise<AgentConnection>;
  listConnections(agentId: string, workspaceId: string): Promise<AgentConnection[]>;
  getConnection(id: string, agentId: string, workspaceId: string): Promise<StoredAgentConnection | undefined>;
  updateConnectionSecret(id: string, agentId: string, workspaceId: string, encryptedSecret: string): Promise<boolean>;
  deleteConnection(id: string, agentId: string, workspaceId: string): Promise<boolean>;
  listAgentsWithEmailAutomation(): Promise<Agent[]>;
  getEmailSettings(agentId: string, workspaceId: string): Promise<EmailSettings | undefined>;
  upsertEmailSettings(input: Omit<EmailSettings, "updatedAt">): Promise<EmailSettings>;
  createEmailCampaign(input: Omit<EmailCampaign, "id" | "createdAt" | "updatedAt" | "sentRows" | "failedRows">): Promise<EmailCampaign>;
  listEmailCampaigns(agentId: string, workspaceId: string, limit: number): Promise<EmailCampaign[]>;
  getEmailCampaign(id: string, agentId: string, workspaceId: string): Promise<EmailCampaign | undefined>;
  updateEmailCampaign(id: string, agentId: string, workspaceId: string, patch: Partial<Pick<EmailCampaign, "status" | "sentRows" | "failedRows" | "totalRows">>): Promise<EmailCampaign | undefined>;
  addEmailCampaignRows(rows: Array<Omit<EmailCampaignRow, "id" | "createdAt" | "updatedAt">>): Promise<EmailCampaignRow[]>;
  listEmailCampaignRows(campaignId: string, limit: number): Promise<EmailCampaignRow[]>;
  updateEmailCampaignRow(id: string, campaignId: string, patch: Partial<Pick<EmailCampaignRow, "status" | "messageId" | "threadId" | "error">>): Promise<EmailCampaignRow | undefined>;
  getEmailReplyEvent(agentId: string, gmailMessageId: string): Promise<EmailReplyEvent | undefined>;
  createEmailReplyEvent(input: Omit<EmailReplyEvent, "id" | "createdAt" | "updatedAt">): Promise<EmailReplyEvent>;
  updateEmailReplyEvent(id: string, agentId: string, patch: Partial<Pick<EmailReplyEvent, "status" | "replyBody" | "replyMessageId" | "error">>): Promise<EmailReplyEvent | undefined>;
  listEmailReplyEvents(agentId: string, workspaceId: string, limit: number): Promise<EmailReplyEvent[]>;
  addUsageEvent(event: UsageEvent): Promise<UsageEvent>;
  listUsage(agentId: string, workspaceId: string, limit: number): Promise<UsageEvent[]>;
  addAuditEvent(event: Omit<AuditEvent, "id" | "createdAt">): Promise<AuditEvent>;
  listAudit(workspaceId: string, limit: number): Promise<AuditEvent[]>;
  adminOverview(): Promise<Record<string, number>>;
  adminCustomers(limit: number): Promise<AdminCustomer[]>;
  adminAgents(limit: number): Promise<AdminAgent[]>;
  adminConversations(limit: number): Promise<AdminConversation[]>;
  adminConversation(conversationId: string): Promise<{ conversation: AdminConversation; messages: Message[] } | undefined>;
  adminUsage(limit: number): Promise<AdminUsageEvent[]>;
  adminDeployments(limit: number): Promise<AdminDeployment[]>;
  adminRevokeDeployment(deploymentId: string): Promise<boolean>;
  adminKnowledge(limit: number): Promise<AdminKnowledge[]>;
  adminTools(): Promise<AdminTool[]>;
  adminActivity(limit: number): Promise<AdminActivity[]>;
};

export type AdminCustomer = { workspaceId: string; customerName?: string; customerEmail?: string; agents: number; responses: number; creditsUsed: number };
export type AdminAgent = Agent & { knowledgeCount: number; conversationCount: number; responses: number; creditsUsed: number; deploymentCount: number };
export type AdminConversation = Conversation & { agentName: string; messageCount: number; lastMessage?: string };
export type AdminUsageEvent = UsageEvent & { agentName: string };
export type AdminDeployment = Deployment & { agentName: string };
export type AdminKnowledge = KnowledgeSource & { agentName: string };
export type AdminTool = { name: string; description: string; agents: number; calls: number };
export type AuditEvent = { id: string; actorId: string; workspaceId: string; action: string; targetType: string; targetId: string; metadata: Record<string, unknown>; createdAt: string };
export type AdminActivity = { id: string; type: "usage" | "conversation" | "deployment" | "audit"; workspaceId: string; agentId?: string; agentName?: string; description: string; status: string; createdAt: string };
export type AdminSettings = { creditMode: string; aiProvider: string; storage: string; adminUsers: number; corsOrigins: number };