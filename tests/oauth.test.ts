import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

process.env.AGENT_CONNECTION_ENCRYPTION_KEY = "oauth-test-encryption-key";
process.env.GOOGLE_CLIENT_ID = "oauth-test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "oauth-test-client-secret";

const { completeOAuth, createAuthorizationUrl, GOOGLE_GMAIL_SEND_SCOPE } = await import("../src/oauth.js");

const agent = {
  id: "agent_420f8756940dc10a",
  workspaceId: "workspace_test",
  level: 3 as const,
};

function signedState() {
  const payload = {
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    provider: "google_gmail" as const,
    issuedAt: Date.now(),
    nonce: "oauth-test-nonce",
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = crypto.createHash("sha256").update(String(process.env.AGENT_CONNECTION_ENCRYPTION_KEY)).digest();
  const signature = crypto.createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function withFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function makeStore() {
  let saved: any;
  return {
    saved: () => saved,
    async getAgent(id: string) { return id === agent.id ? agent : undefined; },
    async createConnection(input: any) { saved = { ...input, id: "conn_oauth_test", status: "connected", permissions: input.permissions, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; return saved; },
    async addAuditEvent(event: any) { return { ...event, id: "audit_oauth_test", createdAt: new Date().toISOString() }; },
  };
}

test("Gmail OAuth requests only gmail.send and does not call users.getProfile", async () => {
  const authorizationUrl = new URL(createAuthorizationUrl("google_gmail", agent.id, agent.workspaceId, "https://engine.example.com/v1/oauth/google_gmail/callback"));
  assert.equal(authorizationUrl.searchParams.get("scope"), GOOGLE_GMAIL_SEND_SCOPE);
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");

  const calls: string[] = [];
  const restore = withFetch(async (input) => {
    calls.push(String(input));
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    return new Response(JSON.stringify({
      access_token: "gmail-access-token",
      refresh_token: "gmail-refresh-token",
      expires_in: 3600,
      scope: GOOGLE_GMAIL_SEND_SCOPE,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const store = makeStore();
  try {
    const connection = await completeOAuth(store as any, "authorization-code", signedState(), "https://engine.example.com/v1/oauth/google_gmail/callback");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls, ["https://oauth2.googleapis.com/token"]);
    assert.equal(connection.provider, "google_gmail");
    assert.equal(connection.status, "connected");
    assert.deepEqual(connection.permissions, [GOOGLE_GMAIL_SEND_SCOPE]);
    assert.equal(store.saved().encryptedSecret.startsWith("v1:"), true);
  } finally {
    restore();
  }
});

test("Gmail OAuth refuses to save a connection when gmail.send was not granted", async () => {
  const restore = withFetch(async () => new Response(JSON.stringify({
    access_token: "gmail-access-token",
    refresh_token: "gmail-refresh-token",
    expires_in: 3600,
    scope: "openid",
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const store = makeStore();
  try {
    await assert.rejects(
      completeOAuth(store as any, "authorization-code", signedState(), "https://engine.example.com/v1/oauth/google_gmail/callback"),
      /did not grant the Gmail send permission/i,
    );
    assert.equal(store.saved(), undefined);
  } finally {
    restore();
  }
});

test("gmail.send-only OAuth connection can be used by the test-email sender", async () => {
  const calls: string[] = [];
  const restore = withFetch(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({
        access_token: "gmail-access-token",
        refresh_token: "gmail-refresh-token",
        expires_in: 3600,
        scope: GOOGLE_GMAIL_SEND_SCOPE,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.equal(url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    return new Response(JSON.stringify({ id: "sent-after-oauth", threadId: "thread-after-oauth" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const store = makeStore();
  try {
    await completeOAuth(store as any, "authorization-code", signedState(), "https://engine.example.com/v1/oauth/google_gmail/callback");
    const { sendGmailTestEmail } = await import("../src/testEmail.js");
    const sent = await sendGmailTestEmail(store.saved(), { to: "recipient@example.com", subject: "OAuth integration test", message: "This is an OAuth integration test." }, { requestId: "oauth_send_test", agentId: agent.id, workspaceId: agent.workspaceId });
    assert.equal(sent.id, "sent-after-oauth");
    assert.deepEqual(calls, ["https://oauth2.googleapis.com/token", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"]);
  } finally {
    restore();
  }
});
