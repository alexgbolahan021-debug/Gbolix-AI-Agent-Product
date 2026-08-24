import assert from "node:assert/strict";
import test from "node:test";

process.env.AI_PROVIDER = "gemini";
process.env.GEMINI_API_KEY = "provider-test-key";

const { complete } = await import("../src/provider.js");

test("AI provider failures never expose provider, model, quota, or raw API details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "quota exceeded for gemini-3.6-flash" } }), { status: 429, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    await assert.rejects(complete({ model: "gemini-3.6-flash", messages: [{ role: "user", content: "Write a reply" }] }), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message, "The agent could not generate a response right now. Please try again later.");
      assert.equal((error as Error).message.toLowerCase().includes("gemini"), false);
      assert.equal((error as Error).message.includes("429"), false);
      assert.equal((error as Error).message.toLowerCase().includes("quota"), false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
