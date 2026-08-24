import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_CONNECTION_ENCRYPTION_KEY = "test-connection-encryption-key";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";

const { encryptGmailCredentials, GmailTestEmailError, sendGmailTestEmail } = await import("../src/testEmail.js");

const scope = "https://www.googleapis.com/auth/gmail.send";
const baseConnection = {
  id: "conn_gmail_test",
  agentId: "agent_420f8756940dc10a",
  workspaceId: "workspace_test",
  kind: "native" as const,
  provider: "google_gmail",
  name: "Google Gmail",
  authType: "bearer" as const,
  status: "connected" as const,
  permissions: [scope],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
const input = { to: "recipient@example.com", subject: "Test subject", message: "Test message" };
const context = { requestId: "test_request", agentId: baseConnection.agentId, workspaceId: baseConnection.workspaceId };

function withFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function expectGmailError(error: unknown, code: string, status: number) {
  assert.ok(error instanceof GmailTestEmailError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return error;
}

test("returns an actionable error when Gmail credentials are missing", async () => {
  await assert.rejects(
    sendGmailTestEmail(baseConnection, input, context),
    (error: unknown) => {
      const typed = expectGmailError(error, "GMAIL_CREDENTIALS_MISSING", 409);
      assert.match(typed.message, /stored credentials/i);
      return true;
    },
  );
});

test("sends a valid MIME message through Gmail and returns message metadata", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const restore = withFetch(async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "gmail_message_1", threadId: "gmail_thread_1" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const result = await sendGmailTestEmail({ ...baseConnection, encryptedSecret: encryptGmailCredentials({ accessToken: "access-token", accountEmail: "sender@example.com", scopes: [scope] }) }, input, context);
    assert.deepEqual(result, { id: "gmail_message_1", threadId: "gmail_thread_1", from: "sender@example.com" });
    assert.equal(requestBody?.raw && typeof requestBody.raw === "string", true);
    assert.match(Buffer.from(String(requestBody?.raw), "base64url").toString("utf8"), /From: sender@example.com/);
    assert.match(Buffer.from(String(requestBody?.raw), "base64url").toString("utf8"), /To: recipient@example.com/);
  } finally {
    restore();
  }
});

test("refreshes an expired token and invokes persistence callback before sending", async () => {
  const calls: string[] = [];
  let authorization = "";
  const restore = withFetch(async (input, init) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      calls.push("refresh");
      return new Response(JSON.stringify({ access_token: "refreshed-access-token", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls.push("send");
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ id: "gmail_message_2" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const refreshed: Record<string, unknown>[] = [];
    const result = await sendGmailTestEmail({ ...baseConnection, encryptedSecret: encryptGmailCredentials({ accessToken: "expired-access-token", refreshToken: "refresh-token", expiresAt: Date.now() - 1000, accountEmail: "sender@example.com", scopes: [scope] }) }, input, { ...context, onTokenRefreshed: async (bundle) => { refreshed.push(bundle); } });
    assert.equal(result.id, "gmail_message_2");
    assert.deepEqual(calls, ["refresh", "send"]);
    assert.equal(authorization, "Bearer refreshed-access-token");
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].accessToken, "refreshed-access-token");
  } finally {
    restore();
  }
});

test("returns Gmail authentication details instead of a generic 500", async () => {
  const restore = withFetch(async () => new Response(JSON.stringify({ error: { code: 401, message: "Invalid Credentials" } }), { status: 401, headers: { "content-type": "application/json" } }));
  try {
    await assert.rejects(
      sendGmailTestEmail({ ...baseConnection, encryptedSecret: encryptGmailCredentials({ accessToken: "invalid-access-token", scopes: [scope] }) }, input, context),
      (error: unknown) => {
        const typed = expectGmailError(error, "GMAIL_REAUTH_REQUIRED", 409);
        assert.match(typed.message, /Invalid Credentials/);
        assert.match(typed.message, /reconnect Gmail/i);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("returns an actionable error when stored credentials cannot be decrypted", async () => {
  await assert.rejects(
    sendGmailTestEmail({ ...baseConnection, encryptedSecret: "v1:invalid:invalid:invalid" }, input, context),
    (error: unknown) => {
      const typed = expectGmailError(error, "GMAIL_CREDENTIALS_DECRYPT_FAILED", 409);
      assert.match(typed.message, /could not be decrypted/i);
      return true;
    },
  );
});
