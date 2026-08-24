import assert from "node:assert/strict";
import test from "node:test";

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
    calls.push(String(input));
    return calls.length === 1 ? new Response(JSON.stringify({ error: { message: "quota exceeded for gemini-3.6-flash" } }), { status: 429, headers: { "content-type": "application/json" } }) : openAiSuccess();
  }) as typeof fetch;
  try {
    const result = await complete({ model: "gemini-3.6-flash", messages: [{ role: "user", content: "Write a reply" }] });
    assert.equal(result.content, "Fallback response");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].includes("generativelanguage.googleapis.com"), true);
    assert.equal(calls[1].includes("/chat/completions"), true);
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
