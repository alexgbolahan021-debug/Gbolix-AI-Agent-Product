import "node:process";

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 4100),
  databaseUrl: process.env.DATABASE_URL,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  defaultModel: process.env.DEFAULT_MODEL ?? "gpt-5-mini",
  creditMode: process.env.CREDIT_MODE ?? "local",
  platformUrl: process.env.GBOLIX_PLATFORM_URL,
  platformToken: process.env.GBOLIX_PLATFORM_TOKEN,
  agentJwtSecret: process.env.AGENT_JWT_SECRET,
  adminUserIds: new Set(list(process.env.AGENT_ADMIN_USER_IDS)),
  corsOrigins: list(process.env.CORS_ORIGINS),
  maxToolRounds: Number(process.env.MAX_TOOL_ROUNDS ?? 3),
  localCredits: Number(process.env.LOCAL_CREDITS ?? 100000),
};

export function isProductionConfig(): boolean {
  return process.env.NODE_ENV === "production";
}
