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

export type Agent = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  tone: string;
  model: string;
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
  getAgent(agentId: string): Promise<Agent | undefined>;
  createAgent(input: Omit<Agent, "id" | "createdAt" | "updatedAt">): Promise<Agent>;
  updateAgent(agentId: string, workspaceId: string, patch: Partial<Pick<Agent, "name" | "description" | "instructions" | "tone" | "model" | "status" | "welcomeMessage" | "enabledTools">>): Promise<Agent | undefined>;
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
  addUsageEvent(event: UsageEvent): Promise<UsageEvent>;
  listUsage(agentId: string, workspaceId: string, limit: number): Promise<UsageEvent[]>;
  adminOverview(): Promise<Record<string, number>>;
  adminCustomers(limit: number): Promise<Array<{ workspaceId: string; agents: number; responses: number; creditsUsed: number }>>;
  adminAgents(limit: number): Promise<AdminAgent[]>;
  adminConversations(limit: number): Promise<AdminConversation[]>;
  adminConversation(conversationId: string): Promise<{ conversation: AdminConversation; messages: Message[] } | undefined>;
  adminUsage(limit: number): Promise<AdminUsageEvent[]>;
  adminDeployments(limit: number): Promise<AdminDeployment[]>;
  adminKnowledge(limit: number): Promise<AdminKnowledge[]>;
  adminTools(): Promise<AdminTool[]>;
  adminActivity(limit: number): Promise<AdminActivity[]>;
};


export type AdminAgent = Agent & {
  knowledgeCount: number;
  conversationCount: number;
  responses: number;
  creditsUsed: number;
  deploymentCount: number;
};

export type AdminConversation = Conversation & {
  agentName: string;
  messageCount: number;
  lastMessage?: string;
};

export type AdminUsageEvent = UsageEvent & { agentName: string };
export type AdminDeployment = Deployment & { agentName: string };
export type AdminKnowledge = KnowledgeSource & { agentName: string };
export type AdminTool = { name: string; description: string; agents: number; calls: number };
export type AdminActivity = { id: string; type: "usage" | "conversation" | "deployment"; workspaceId: string; agentId?: string; agentName?: string; description: string; status: string; createdAt: string };
export type AdminSettings = { creditMode: string; aiProvider: string; storage: string; adminUsers: number; corsOrigins: number };
