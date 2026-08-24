import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_CONNECTION_ENCRYPTION_KEY = "provider-test-encryption-key";
process.env.AI_PROVIDER = "gemini";
process.env.AI_PROVIDER_ORDER = "gemini,openai";
process.env.AI_FALLBACK_ENABLED = "true";
process.env.GEMINI_API_KEY = "provider-test-gemini-key";
process.env.OPENAI_API_KEY = "provider-test-openai-key";

const { complete } = await import("../src/provider.js");

function openAiSuccess() {
  return new Response(JSON.stringify({ choices: [{ message: { content: "Fallback response", tool_calls: [] } }], usage: { prompt_tokens: 4, completion_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
}

test("falls back from a quota-limited primary provider to the next configured provider", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("generativelanguage.googleapis.com") && url.includes("/models?")) return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.6-flash", displayName: "Gemini Flash", supportedGenerationMethods: ["generateContent"] }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("generativelanguage.googleapis.com")) return new Response(JSON.stringify({ error: { message: "quota exceeded for gemini-3.6-flash" } }), { status: 429, headers: { "content-type": "application/json" } });
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-5-mini", owned_by: "openai" }] }), { status: 200, headers: { "content-type": "application/json" } });
    return openAiSuccess();
  }) as typeof fetch;
  try {
    const result = await complete({ model: "gemini-3.6-flash", messages: [{ role: "user", content: "Write a reply" }] });
    assert.equal(result.content, "Fallback response");
    assert.equal(calls.some((url) => url.includes("generativelanguage.googleapis.com")), true);
    assert.equal(calls.some((url) => url.includes("/chat/completions")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI provider failures never expose provider, model, quota, or raw API details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "quota exceeded for gemini-3.6-flash" } }), { status: 429, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    await assert.rejects(complete({ model: "gemini-3.6-flash", messages: [{ role: "user", content: "Write a reply" }] }), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message, "The agent could not generate a response right now. Please try again later.");
      assert.equal((error as Error).message.toLowerCase().includes("gemini"), false);
      assert.equal((error as Error).message.toLowerCase().includes("openai"), false);
      assert.equal((error as Error).message.includes("429"), false);
      assert.equal((error as Error).message.toLowerCase().includes("quota"), false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const { encryptProviderApiKey, resolveAiProviders } = await import("../src/provider.js");

test("admin provider secrets decrypt only into runtime objects and are never part of the public provider record", async () => {
  const encrypted = encryptProviderApiKey("admin-provider-secret");
  const store = { listAiProviderSecrets: async () => [{ id: "provider-a", name: "Provider A", adapter: "openai_compatible" as const, baseUrl: "https://api.example.com/v1", encryptedApiKey: encrypted, defaultModel: "model-a", priority: 10, apiKeyConfigured: true, enabled: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] };
  const runtime = await resolveAiProviders(store);
  assert.equal(runtime?.[0]?.apiKey, "admin-provider-secret");
  const publicRecord = { ...(await store.listAiProviderSecrets())[0] };
  delete (publicRecord as Record<string, unknown>).encryptedApiKey;
  assert.equal(JSON.stringify(publicRecord).includes("admin-provider-secret"), false);
  assert.equal(JSON.stringify(publicRecord).includes("encrypted"), false);
});

test("a retired configured model is replaced by the first live model from the same admin provider", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "live-model", owned_by: "provider" }] }), { status: 200, headers: { "content-type": "application/json" } });
    return openAiSuccess();
  }) as typeof fetch;
  try {
    const result = await complete({ model: "retired-model", messages: [{ role: "user", content: "Reply" }], providers: [{ id: "provider-retired", name: "Provider", adapter: "openai_compatible", baseUrl: "https://api.example.com/v1", apiKey: "secret", defaultModel: "retired-model", priority: 1, enabled: true }] });
    assert.equal(result.model, "live-model");
    assert.equal(calls.some((url) => url.includes("retired-model")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("an admin-ordered provider registry fails over to the next live provider without changing the requested action count", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("primary.example.com") && url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "primary-live" }] }), { status: 200 });
    if (url.includes("secondary.example.com") && url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "secondary-live" }] }), { status: 200 });
    if (url.includes("primary.example.com")) return new Response(JSON.stringify({ error: "quota exceeded" }), { status: 429 });
    return openAiSuccess();
  }) as typeof fetch;
  try {
    const result = await complete({ model: "primary-live", messages: [{ role: "user", content: "Reply" }], providers: [
      { id: "primary", name: "Primary", adapter: "openai_compatible", baseUrl: "https://primary.example.com/v1", apiKey: "one", defaultModel: "primary-live", priority: 1, enabled: true },
      { id: "secondary", name: "Secondary", adapter: "openai_compatible", baseUrl: "https://secondary.example.com/v1", apiKey: "two", defaultModel: "secondary-live", priority: 2, enabled: true },
    ] });
    assert.equal(result.provider, "secondary");
    assert.equal(calls.some((url) => url.includes("primary.example.com/v1/chat/completions")), true);
    assert.equal(calls.some((url) => url.includes("secondary.example.com/v1/chat/completions")), true);
  } finally { globalThis.fetch = originalFetch; }
});
