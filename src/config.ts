import "node:process";

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 4100),
  databaseUrl: process.env.DATABASE_URL,
  allowMemoryStorage: process.env.ALLOW_MEMORY_STORAGE === "true",
  aiProvider: process.env.AI_PROVIDER ?? "openai",
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiBaseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
  defaultModel: process.env.DEFAULT_MODEL ?? "gpt-5-mini",
  openAiModel: process.env.OPENAI_DEFAULT_MODEL ?? process.env.DEFAULT_MODEL ?? "gpt-5-mini",
  geminiModel: process.env.GEMINI_DEFAULT_MODEL ?? "gemini-2.5-flash-lite",
  creditMode: process.env.CREDIT_MODE ?? "local",
  platformUrl: process.env.GBOLIX_PLATFORM_URL,
  platformToken: process.env.GBOLIX_PLATFORM_TOKEN,
  frontendUrl: process.env.GBOLIX_FRONTEND_URL ?? "https://gbolix.site",
  agentJwtSecret: process.env.AGENT_JWT_SECRET,
  connectionEncryptionKey: process.env.AGENT_CONNECTION_ENCRYPTION_KEY ?? process.env.AGENT_JWT_SECRET,
  hubspotClientId: process.env.HUBSPOT_CLIENT_ID,
  hubspotClientSecret: process.env.HUBSPOT_CLIENT_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  clerkSecretKey: process.env.CLERK_SECRET_KEY,
  adminUserIds: new Set(list(process.env.AGENT_ADMIN_USER_IDS)),
  corsOrigins: list(process.env.CORS_ORIGINS || "https://gbolix.site,https://www.gbolix.site"),
  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS ?? 3),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000),
  rateLimitMaxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 60),
  localCredits: Number(process.env.LOCAL_CREDITS ?? 100000),
  emailCampaignMaxRows: Number(process.env.EMAIL_CAMPAIGN_MAX_ROWS ?? 500),
  emailPollingEnabled: process.env.EMAIL_POLLING_ENABLED === "true",
  emailPollingIntervalMs: Number(process.env.EMAIL_POLLING_INTERVAL_MS ?? 300000),
};

export function isProductionConfig(): boolean {
  return process.env.NODE_ENV === "production";
}
