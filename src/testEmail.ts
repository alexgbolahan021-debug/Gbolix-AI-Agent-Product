import crypto from "node:crypto";
import type { AgentConnection } from "./types.js";
import { config } from "./config.js";

function decryptSecret(value: string): string {
  if (!config.connectionEncryptionKey) throw new Error("AGENT_CONNECTION_ENCRYPTION_KEY is required to use encrypted connections.");
  const key = crypto.createHash("sha256").update(config.connectionEncryptionKey).digest();
  const [version, ivText, tagText, ciphertextText] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted connection secret.");
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export async function sendGmailTestEmail(connection: AgentConnection & { encryptedSecret?: string }, input: { to: string; subject: string; message: string }) {
  if (connection.provider !== "google_gmail") throw new Error("A Google Gmail connection is required to send test email.");
  if (!connection.encryptedSecret) throw new Error("The Gmail connection has no stored credentials. Please reconnect Gmail.");
  if (!connection.permissions.includes("https://www.googleapis.com/auth/gmail.send")) throw new Error("The connected Gmail account does not have permission to send email. Please reconnect Gmail and approve Gmail sending access.");
  const bundle = JSON.parse(decryptSecret(connection.encryptedSecret)) as { accessToken?: string; refreshToken?: string; expiresAt?: number; accountEmail?: string };
  let accessToken = bundle.accessToken;
  if (!accessToken) throw new Error("The Gmail connection is missing an access token. Please reconnect Gmail.");
  if (bundle.expiresAt && bundle.expiresAt <= Date.now() + 60_000) {
    if (!bundle.refreshToken || !config.googleClientId || !config.googleClientSecret) throw new Error("The Gmail connection has expired. Please reconnect Gmail.");
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: bundle.refreshToken, client_id: config.googleClientId, client_secret: config.googleClientSecret }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const tokenData = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
    if (!tokenResponse.ok || typeof tokenData.access_token !== "string") throw new Error("The Gmail connection could not be refreshed. Please reconnect Gmail.");
    accessToken = tokenData.access_token;
  }
  const from = bundle.accountEmail || "me";
  const raw = [`From: ${from}`, `To: ${input.to}`, `Subject: ${input.subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", input.message].join("\r\n");
  const encoded = Buffer.from(raw, "utf8").toString("base64url");
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof data.error_description === "string" ? data.error_description : typeof (data.error as Record<string, unknown> | undefined)?.message === "string" ? (data.error as Record<string, unknown>).message : `Gmail returned ${response.status}.`;
    throw new Error(detail);
  }
  return { id: typeof data.id === "string" ? data.id : undefined, threadId: typeof data.threadId === "string" ? data.threadId : undefined, from };
}
