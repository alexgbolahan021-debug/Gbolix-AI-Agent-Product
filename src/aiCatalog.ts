import { config } from "./config.js";
import type { AiModelInfo, AiProviderCatalog, AiProviderId } from "./types.js";

const providers: AiProviderId[] = ["gemini", "openai"];
const PUBLIC_CATALOG_ERROR = "Live models could not be loaded right now.";

function configured(provider: AiProviderId) { return provider === "gemini" ? Boolean(config.geminiApiKey) : Boolean(config.openAiApiKey); }

function modelIsLive(provider: AiProviderId, id: string) {
  if (provider === "gemini") return id.startsWith("gemini-");
  return Boolean(id);
}

export async function loadProviderModels(provider: AiProviderId): Promise<AiModelInfo[]> {
  if (provider === "gemini") {
    const response = await fetch(`${config.geminiBaseUrl.replace(/\/$/, "")}/models?key=${encodeURIComponent(config.geminiApiKey ?? "")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Gemini model catalog HTTP ${response.status}`);
    const data = await response.json() as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (data.models ?? []).map((item) => ({ id: String(item.name ?? "").replace(/^models\//, ""), displayName: item.displayName, live: modelIsLive(provider, String(item.name ?? "").replace(/^models\//, "")), deprecated: false })).filter((item) => item.id && item.live && (!item.id.includes("embedding") && !item.id.includes("tts")));
  }
  const response = await fetch(`${config.openAiBaseUrl.replace(/\/$/, "")}/models`, { headers: { accept: "application/json", authorization: `Bearer ${config.openAiApiKey}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`OpenAI-compatible model catalog HTTP ${response.status}`);
  const data = await response.json() as { data?: Array<{ id?: string; owned_by?: string }> };
  return (data.data ?? []).map((item) => ({ id: String(item.id ?? ""), displayName: item.owned_by ? `${item.id} (${item.owned_by})` : item.id, live: Boolean(item.id), deprecated: false })).filter((item) => item.id && !/embedding|moderation|whisper|tts|image/i.test(item.id));
}

export async function loadAiProviderCatalog(): Promise<AiProviderCatalog[]> {
  return Promise.all(providers.map(async (provider): Promise<AiProviderCatalog> => {
    const checkedAt = new Date().toISOString();
    if (!configured(provider)) return { provider, configured: false, available: false, models: [], checkedAt, error: "Provider credentials are not configured." };
    try { const models = await loadProviderModels(provider); return { provider, configured: true, available: models.length > 0, models, checkedAt, ...(models.length ? {} : { error: PUBLIC_CATALOG_ERROR }) }; }
    catch (error) { console.error("[Gbolix ai-catalog] provider_check_failed", JSON.stringify({ provider, error: error instanceof Error ? error.message : String(error) })); return { provider, configured: true, available: false, models: [], checkedAt, error: PUBLIC_CATALOG_ERROR }; }
  }));
}
