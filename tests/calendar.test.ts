import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

process.env.AGENT_CONNECTION_ENCRYPTION_KEY = "calendar-test-encryption-key";
process.env.GOOGLE_CLIENT_ID = "calendar-test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "calendar-test-client-secret";

const { executeGoogleCalendarAction } = await import("../src/calendar.js");

function seal(value: unknown) {
  const key = crypto.createHash("sha256").update(process.env.AGENT_CONNECTION_ENCRYPTION_KEY!).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

function fixture(overrides: Record<string, unknown> = {}) {
  const agent = { id: "agent_calendar", workspaceId: "workspace_calendar", name: "Calendar agent", description: "", instructions: "", tone: "concise", model: "gpt-5-mini", level: 3 as const, status: "active" as const, welcomeMessage: "Hello", enabledTools: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const connection = { id: "conn_calendar", agentId: agent.id, workspaceId: agent.workspaceId, kind: "native" as const, provider: "google_calendar", name: "Google Calendar", status: "connected" as const, permissions: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"], encryptedSecret: seal({ accessToken: "calendar-access-token", refreshToken: "calendar-refresh-token", expiresAt: Date.now() + 3600000, scopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"] }), createdAt: agent.createdAt, updatedAt: agent.updatedAt, ...overrides };
  let persistedSecret = "";
  const store = { updateConnectionSecret: async (_id: string, _agentId: string, _workspaceId: string, value: string) => { persistedSecret = value; return true; } };
  return { agent, connection, store, get persistedSecret() { return persistedSecret; } };
}

function jsonResponse(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }

 test("checks Google Calendar availability through freeBusy", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => { assert.match(String(input), /calendar\/v3\/freeBusy$/); return jsonResponse({ calendars: { primary: { busy: [] } } }); }) as typeof fetch;
  try {
    const f = fixture();
    const result = await executeGoogleCalendarAction(f.store as any, f.agent, f.connection as any, "calendar_check_availability", JSON.stringify({ start: "2026-08-25T14:00:00+01:00", end: "2026-08-25T15:00:00+01:00", timeZone: "Africa/Lagos" }), "request_availability");
    assert.equal(JSON.parse(result.output).available, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("refreshes an expired Calendar token and persists the refreshed encrypted bundle", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => { const url = String(input); calls.push(url); if (url.includes("oauth2.googleapis.com/token")) return jsonResponse({ access_token: "refreshed-calendar-token", expires_in: 3600 }); return jsonResponse({ calendars: { primary: { busy: [] } } }); }) as typeof fetch;
  try {
    const f = fixture({ encryptedSecret: seal({ accessToken: "expired-calendar-token", refreshToken: "calendar-refresh-token", expiresAt: Date.now() - 1000, scopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"] }) });
    const result = await executeGoogleCalendarAction(f.store as any, f.agent, f.connection as any, "calendar_check_availability", JSON.stringify({ start: "2026-08-25T14:00:00Z", end: "2026-08-25T15:00:00Z" }), "request_refresh");
    assert.equal(JSON.parse(result.output).available, true);
    assert.equal(calls.some((url) => url.includes("oauth2.googleapis.com/token")), true);
    assert.ok(f.persistedSecret.startsWith("v1:"));
  } finally { globalThis.fetch = originalFetch; }
});

test("does not create a duplicate appointment for the same agent action request", async () => {
  const originalFetch = globalThis.fetch;
  let postCount = 0;
  globalThis.fetch = (async (input, init) => { if (init?.method === "POST") postCount += 1; return jsonResponse({ items: [{ id: "existing_event" }] }); }) as typeof fetch;
  try {
    const f = fixture();
    const result = await executeGoogleCalendarAction(f.store as any, f.agent, f.connection as any, "calendar_create_event", JSON.stringify({ summary: "Consultation", start: "2026-08-25T14:00:00Z", end: "2026-08-25T15:00:00Z" }), "request_duplicate");
    assert.equal(JSON.parse(result.output).action, "calendar_event_already_created");
    assert.equal(postCount, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("checks availability before creating a Calendar event", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => { const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`); if (init?.method === "GET") return jsonResponse({ items: [] }); if (url.endsWith("/freeBusy")) return jsonResponse({ calendars: { primary: { busy: [] } } }); return jsonResponse({ id: "created_event", summary: "Consultation", htmlLink: "https://calendar.google.com/event" }); }) as typeof fetch;
  try {
    const f = fixture();
    const result = await executeGoogleCalendarAction(f.store as any, f.agent, f.connection as any, "calendar_create_event", JSON.stringify({ summary: "Consultation", start: "2026-08-25T14:00:00Z", end: "2026-08-25T15:00:00Z", attendeeEmail: "customer@example.com" }), "request_create");
    assert.equal(JSON.parse(result.output).action, "calendar_event_created");
    assert.equal(calls.some((call) => call.includes("freeBusy")), true);
    assert.equal(calls.some((call) => call.startsWith("POST https://www.googleapis.com/calendar/v3/calendars/primary/events")), true);
  } finally { globalThis.fetch = originalFetch; }
});

test("redacts Calendar provider failures from the tool result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse({ error: { message: "secret-calendar-token leaked" } }, 403)) as typeof fetch;
  try {
    const f = fixture();
    const result = await executeGoogleCalendarAction(f.store as any, f.agent, f.connection as any, "calendar_check_availability", JSON.stringify({ start: "2026-08-25T14:00:00Z", end: "2026-08-25T15:00:00Z" }), "request_failure");
    assert.equal(result.output.includes("secret-calendar-token"), false);
    assert.match(result.output, /could not be completed/);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects a Calendar connection belonging to a different agent", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return jsonResponse({}); }) as typeof fetch;
  try {
    const f = fixture({ agentId: "another_agent" });
    const result = await executeGoogleCalendarAction(f.store as any, f.agent, f.connection as any, "calendar_check_availability", JSON.stringify({ start: "2026-08-25T14:00:00Z", end: "2026-08-25T15:00:00Z" }), "request_isolation");
    assert.equal(called, false);
    assert.match(result.output, /could not be completed/);
  } finally { globalThis.fetch = originalFetch; }
});
