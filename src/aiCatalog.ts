import type { AiModelInfo, AiProvider, AiProviderCatalog, AiProviderRuntime } from "./types.js";

const PUBLIC_CATALOG_ERROR = "Live models could not be loaded right now.";

function runtimeProvider(provider: AiProvider | AiProviderRuntime): AiProviderRuntime { return "apiKey" in provider ? provider : { id: provider.id, name: provider.name, adapter: provider.adapter, baseUrl: provider.baseUrl, apiKey: "", defaultModel: provider.defaultModel, priority: provider.priority, enabled: provider.enabled }; }

export async function loadProviderModels(providerInput: AiProviderRuntime): Promise<AiModelInfo[]> {
  const provider = runtimeProvider(providerInput);
  if (!provider.apiKey) throw new Error("Provider API key is not configured.");
  if (provider.adapter === "gemini") {
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models?key=${encodeURIComponent(provider.apiKey)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Provider model catalog HTTP ${response.status}`);
    const data = await response.json() as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (data.models ?? []).map((item) => ({ id: String(item.name ?? "").replace(/^models\//, ""), displayName: item.displayName, live: Boolean(item.name) && (item.supportedGenerationMethods ?? []).includes("generateContent"), deprecated: false })).filter((item) => item.id && item.live && !/embedding|tts|image|moderation/i.test(item.id));
  }
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, { headers: { accept: "application/json", authorization: `Bearer ${provider.apiKey}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Provider model catalog HTTP ${response.status}`);
  const data = await response.json() as { data?: Array<{ id?: string; owned_by?: string }> };
  return (data.data ?? []).map((item) => ({ id: String(item.id ?? ""), displayName: item.owned_by ? `${item.id} (${item.owned_by})` : item.id, live: Boolean(item.id), deprecated: false })).filter((item) => item.id && !/embedding|moderation|whisper|tts|image/i.test(item.id));
}

export async function loadAiProviderCatalog(providers: AiProviderRuntime[] = []): Promise<AiProviderCatalog[]> {
  return Promise.all(providers.filter((provider) => provider.enabled).map(async (provider): Promise<AiProviderCatalog> => {
    const checkedAt = new Date().toISOString();
    if (!provider.apiKey) return { provider: provider.id, name: provider.name, adapter: provider.adapter, configured: false, available: false, models: [], checkedAt, error: PUBLIC_CATALOG_ERROR };
    try { const models = await loadProviderModels(provider); return { provider: provider.id, name: provider.name, adapter: provider.adapter, configured: true, available: models.length > 0, models, checkedAt, ...(models.length ? {} : { error: PUBLIC_CATALOG_ERROR }) }; }
    catch (error) { console.error("[Gbolix ai-catalog] provider_check_failed", JSON.stringify({ providerId: provider.id, adapter: provider.adapter, error: error instanceof Error ? error.message : String(error) })); return { provider: provider.id, name: provider.name, adapter: provider.adapter, configured: true, available: false, models: [], checkedAt, error: PUBLIC_CATALOG_ERROR }; }
  }));
}
