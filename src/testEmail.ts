import crypto from "node:crypto";
import type { AgentConnection } from "./types.js";
import { config } from "./config.js";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

type GmailTokenBundle = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  accountId?: string;
  accountEmail?: string;
};

export type GmailAccessToken = { accessToken: string; accountEmail?: string; scopes?: string[] };

export type GmailTestEmailContext = {
  requestId?: string;
  agentId?: string;
  workspaceId?: string;
  onTokenRefreshed?: (bundle: GmailTokenBundle) => Promise<void>;
};

export class GmailTestEmailError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly stage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GmailTestEmailError";
  }
}

function logStage(stage: string, context: GmailTestEmailContext, fields: Record<string, unknown> = {}) {
  console.info("[Gbolix test-email]", JSON.stringify({
    stage,
    requestId: context.requestId,
    agentId: context.agentId,
    workspaceId: context.workspaceId,
    ...fields,
  }));
}

function fail(message: string, code: string, status: number, stage: string, cause?: unknown): never {
  throw new GmailTestEmailError(message, code, status, stage, { cause });
}

function encryptionSecret(): string {
  const value = config.connectionEncryptionKey ?? config.agentJwtSecret;
  if (!value) fail("Gmail connection encryption is not configured on the server. Set AGENT_CONNECTION_ENCRYPTION_KEY and reconnect Gmail.", "GMAIL_ENCRYPTION_NOT_CONFIGURED", 503, "configuration");
  return value;
}

function encryptionKey() {
  return crypto.createHash("sha256").update(encryptionSecret()).digest();
}

export function encryptGmailCredentials(bundle: GmailTokenBundle): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(bundle), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptSecret(value: string, context: GmailTestEmailContext): string {
  let ivText: string | undefined;
  let tagText: string | undefined;
  let ciphertextText: string | undefined;
  try {
    const parts = value.split(":");
    const version = parts.shift();
    [ivText, tagText, ciphertextText] = parts;
    if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("invalid secret format");
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    const ciphertext = Buffer.from(ciphertextText, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    logStage("credentials_decrypt_failed", context, { hasSecret: Boolean(value), hasIv: Boolean(ivText), hasTag: Boolean(tagText), hasCiphertext: Boolean(ciphertextText) });
    fail("The stored Gmail credentials could not be decrypted. Please reconnect Google Gmail so the credentials are stored again.", "GMAIL_CREDENTIALS_DECRYPT_FAILED", 409, "credentials_decrypt", error);
  }
}

function parseGoogleError(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.error_description === "string" && data.error_description.trim()) return data.error_description.trim();
  const error = data.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const detail = error as Record<string, unknown>;
    if (typeof detail.message === "string" && detail.message.trim()) return detail.message.trim();
    if (typeof detail.status === "string" && detail.status.trim()) return detail.status.trim();
  }
  return fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function getGmailAccessToken(
  connection: AgentConnection & { encryptedSecret?: string },
  context: GmailTestEmailContext = {},
): Promise<GmailAccessToken> {
  if (connection.provider !== "google_gmail") fail("A Google Gmail connection is required for email automation.", "GMAIL_PROVIDER_INVALID", 409, "connection_validation");
  if (connection.status !== "connected") fail("Gmail is not connected for this agent. Reconnect Gmail before using email automation.", "GMAIL_NOT_CONNECTED", 409, "connection_validation");
  if (!connection.encryptedSecret) fail("The Gmail connection has no stored credentials. Please reconnect Gmail.", "GMAIL_CREDENTIALS_MISSING", 409, "connection_validation");
  const scopes = connection.permissions;
  if (!scopes.includes(GMAIL_SEND_SCOPE)) fail("The connected Gmail account does not have permission to send email. Please reconnect Gmail and approve Gmail sending access.", "GMAIL_SEND_SCOPE_MISSING", 409, "connection_validation");
  if (!scopes.includes(GMAIL_READ_SCOPE)) fail("Inbox monitoring requires Gmail read permission. Reconnect Gmail and approve Gmail inbox access.", "GMAIL_READ_SCOPE_MISSING", 409, "connection_validation");
  const decrypted = decryptSecret(connection.encryptedSecret, context);
  let bundle: GmailTokenBundle;
  try { bundle = JSON.parse(decrypted) as GmailTokenBundle; } catch (error) { fail("The stored Gmail credentials are invalid. Please reconnect Gmail.", "GMAIL_CREDENTIALS_INVALID", 409, "credentials_parse", error); }
  if (!bundle.accessToken) fail("The Gmail connection is missing an access token. Please reconnect Gmail.", "GMAIL_ACCESS_TOKEN_MISSING", 409, "token_validation");
  if (bundle.expiresAt && bundle.expiresAt <= Date.now() + 60_000) {
    if (!bundle.refreshToken || !config.googleClientId || !config.googleClientSecret) fail("The Gmail connection has expired and cannot be refreshed. Please reconnect Gmail.", "GMAIL_REAUTH_REQUIRED", 409, "token_refresh");
    let tokenResponse: Response;
    try { tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: bundle.refreshToken, client_id: config.googleClientId, client_secret: config.googleClientSecret }).toString(), signal: AbortSignal.timeout(10000) }); } catch (error) { fail(`The Gmail authorization could not be refreshed because Google was unreachable: ${errorMessage(error)}. Please retry or reconnect Gmail.`, "GMAIL_TOKEN_REFRESH_FAILED", 502, "token_refresh", error); }
    const tokenData = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
    if (!tokenResponse.ok || typeof tokenData.access_token !== "string") fail(`The Gmail connection could not be refreshed: ${parseGoogleError(tokenData, `Google token refresh failed (HTTP ${tokenResponse.status})`)}. Please reconnect Gmail.`, tokenData.error === "invalid_grant" ? "GMAIL_REAUTH_REQUIRED" : "GMAIL_TOKEN_REFRESH_FAILED", tokenData.error === "invalid_grant" ? 409 : 502, "token_refresh");
    bundle = { ...bundle, accessToken: tokenData.access_token, expiresAt: typeof tokenData.expires_in === "number" ? Date.now() + tokenData.expires_in * 1000 : undefined, refreshToken: typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : bundle.refreshToken };
    if (context.onTokenRefreshed) await context.onTokenRefreshed(bundle);
  }
  return { accessToken: bundle.accessToken!, accountEmail: bundle.accountEmail, scopes: bundle.scopes ?? connection.permissions };
}

export async function sendGmailTestEmail(
  connection: AgentConnection & { encryptedSecret?: string },
  input: { to: string; subject: string; message: string; threadId?: string; inReplyTo?: string; references?: string },
  context: GmailTestEmailContext = {},
) {
  logStage("send_started", context, {
    connectionId: connection.id,
    provider: connection.provider,
    connectionStatus: connection.status,
    recipientDomain: input.to.split("@")[1] ?? "unknown",
    subjectLength: input.subject.length,
    messageLength: input.message.length,
  });

  if (connection.provider !== "google_gmail") fail("A Google Gmail connection is required to send test email.", "GMAIL_PROVIDER_INVALID", 409, "connection_validation");
  if (connection.status !== "connected") fail("Gmail is not connected for this agent. Reconnect Gmail before sending a test email.", "GMAIL_NOT_CONNECTED", 409, "connection_validation");
  if (!connection.encryptedSecret) fail("The Gmail connection has no stored credentials. Please reconnect Gmail.", "GMAIL_CREDENTIALS_MISSING", 409, "connection_validation");
  if (!connection.permissions.includes(GMAIL_SEND_SCOPE)) fail("The connected Gmail account does not have permission to send email. Please reconnect Gmail and approve Gmail sending access.", "GMAIL_SEND_SCOPE_MISSING", 409, "connection_validation");
  logStage("connection_validated", context, { connectionId: connection.id, permissionCount: connection.permissions.length, hasEncryptedSecret: true });

  const decrypted = decryptSecret(connection.encryptedSecret, context);
  let bundle: GmailTokenBundle;
  try {
    bundle = JSON.parse(decrypted) as GmailTokenBundle;
  } catch (error) {
    logStage("credentials_parse_failed", context, { connectionId: connection.id });
    fail("The stored Gmail credentials are invalid. Please reconnect Gmail.", "GMAIL_CREDENTIALS_INVALID", 409, "credentials_parse", error);
  }

  let accessToken = bundle.accessToken;
  if (!accessToken) fail("The Gmail connection is missing an access token. Please reconnect Gmail.", "GMAIL_ACCESS_TOKEN_MISSING", 409, "token_validation");
  logStage("credentials_loaded", context, {
    connectionId: connection.id,
    hasAccessToken: true,
    hasRefreshToken: Boolean(bundle.refreshToken),
    expiresAt: bundle.expiresAt,
    accountEmail: bundle.accountEmail,
    scopes: bundle.scopes,
  });

  if (bundle.expiresAt && bundle.expiresAt <= Date.now() + 60_000) {
    logStage("token_refresh_started", context, { connectionId: connection.id, hasRefreshToken: Boolean(bundle.refreshToken), hasGoogleClientId: Boolean(config.googleClientId), hasGoogleClientSecret: Boolean(config.googleClientSecret) });
    if (!bundle.refreshToken || !config.googleClientId || !config.googleClientSecret) fail("The Gmail connection has expired and cannot be refreshed. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then reconnect Gmail.", "GMAIL_REAUTH_REQUIRED", 409, "token_refresh");
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: bundle.refreshToken, client_id: config.googleClientId, client_secret: config.googleClientSecret }).toString(),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      logStage("token_refresh_network_failed", context, { connectionId: connection.id, error: errorMessage(error) });
      fail(`The Gmail authorization could not be refreshed because Google was unreachable: ${errorMessage(error)}. Please retry or reconnect Gmail.`, "GMAIL_TOKEN_REFRESH_FAILED", 502, "token_refresh", error);
    }
    const tokenData = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
    if (!tokenResponse.ok || typeof tokenData.access_token !== "string") {
      const detail = parseGoogleError(tokenData, `Google token refresh failed (HTTP ${tokenResponse.status})`);
      const code = tokenData.error === "invalid_grant" ? "GMAIL_REAUTH_REQUIRED" : "GMAIL_TOKEN_REFRESH_FAILED";
      const status = tokenData.error === "invalid_grant" ? 409 : 502;
      logStage("token_refresh_rejected", context, { connectionId: connection.id, httpStatus: tokenResponse.status, googleError: detail, code });
      fail(`The Gmail connection could not be refreshed: ${detail}. ${status === 409 ? "Please reconnect Gmail." : "Please retry or reconnect Gmail."}`, code, status, "token_refresh");
    }
    accessToken = tokenData.access_token;
    bundle = { ...bundle, accessToken, expiresAt: typeof tokenData.expires_in === "number" ? Date.now() + tokenData.expires_in * 1000 : undefined, refreshToken: typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : bundle.refreshToken };
    logStage("token_refresh_succeeded", context, { connectionId: connection.id, expiresAt: bundle.expiresAt, rotatedRefreshToken: typeof tokenData.refresh_token === "string" });
    if (context.onTokenRefreshed) {
      try {
        await context.onTokenRefreshed(bundle);
        logStage("refreshed_credentials_persisted", context, { connectionId: connection.id });
      } catch (error) {
        logStage("refreshed_credentials_persist_failed", context, { connectionId: connection.id, error: errorMessage(error) });
        fail(`The Gmail access token was refreshed, but the refreshed credentials could not be saved: ${errorMessage(error)}. Please retry.`, "GMAIL_TOKEN_PERSIST_FAILED", 503, "token_persist", error);
      }
    }
  } else {
    logStage("token_refresh_not_needed", context, { connectionId: connection.id, expiresAt: bundle.expiresAt });
  }

  const headers = [
    ...(bundle.accountEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bundle.accountEmail) ? [`From: ${bundle.accountEmail}`] : []),
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    "",
    input.message,
  ];
  const encoded = Buffer.from(headers.join("\r\n"), "utf8").toString("base64url");
  logStage("gmail_api_send_started", context, { connectionId: connection.id, endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", hasAccessToken: Boolean(accessToken), encodedMessageLength: encoded.length, threadId: input.threadId, isReply: Boolean(input.threadId) });

  let response: Response;
  try {
    response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ raw: encoded, ...(input.threadId ? { threadId: input.threadId } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    logStage("gmail_api_network_failed", context, { connectionId: connection.id, error: errorMessage(error) });
    fail(`Gmail could not be reached: ${errorMessage(error)}. Please retry.`, "GMAIL_API_UNREACHABLE", 502, "gmail_api_send", error);
  }

  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detail = parseGoogleError(data, `Gmail returned HTTP ${response.status}`);
    const code = response.status === 401 ? "GMAIL_REAUTH_REQUIRED" : response.status === 403 ? "GMAIL_PERMISSION_DENIED" : "GMAIL_SEND_REJECTED";
    const status = response.status === 401 || response.status === 403 ? 409 : 502;
    logStage("gmail_api_send_rejected", context, { connectionId: connection.id, httpStatus: response.status, googleError: detail, code });
    fail(`Gmail rejected the test email: ${detail}. ${status === 409 ? "Please reconnect Gmail and approve Gmail sending access." : "Please retry after checking the Gmail connection."}`, code, status, "gmail_api_send");
  }

  const sent = {
    id: typeof data.id === "string" ? data.id : undefined,
    threadId: typeof data.threadId === "string" ? data.threadId : undefined,
    from: bundle.accountEmail,
  };
  logStage("gmail_api_send_succeeded", context, { connectionId: connection.id, messageId: sent.id, threadId: sent.threadId, accountEmail: sent.from });
  return sent;
}
