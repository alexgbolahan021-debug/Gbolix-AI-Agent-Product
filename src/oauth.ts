import crypto from "node:crypto";
import { config } from "./config.js";
import type { Store } from "./types.js";

export type OAuthProvider = "hubspot" | "google_gmail" | "google_calendar";

type State = { agentId: string; workspaceId: string; provider: OAuthProvider; issuedAt: number; nonce: string };

type TokenBundle = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  accountId?: string;
  accountEmail?: string;
};

const HUBSPOT_SCOPES = ["crm.objects.contacts.read", "crm.objects.contacts.write"];
const GOOGLE_GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"];
const GOOGLE_CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

function secretKey() {
  const value = config.connectionEncryptionKey ?? config.agentJwtSecret;
  if (!value) throw new Error("AGENT_CONNECTION_ENCRYPTION_KEY or AGENT_JWT_SECRET must be configured for OAuth connections.");
  return crypto.createHash("sha256").update(value).digest();
}

function signState(payload: State) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secretKey()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyState(value: string): State {
  const [body, signature] = value.split(".");
  if (!body || !signature) throw new Error("Invalid OAuth state.");
  const expected = crypto.createHmac("sha256", secretKey()).update(body).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("Invalid OAuth state signature.");
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as State;
  if (!parsed?.agentId || !parsed?.workspaceId || !parsed?.provider || !parsed?.nonce || !Number.isFinite(parsed.issuedAt)) throw new Error("Invalid OAuth state payload.");
  if (Date.now() - parsed.issuedAt > 10 * 60 * 1000) throw new Error("OAuth authorization expired. Please try connecting again.");
  return parsed;
}

function seal(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

function providerConfig(provider: OAuthProvider) {
  if (provider === "hubspot") {
    if (!config.hubspotClientId || !config.hubspotClientSecret) throw new Error("HubSpot OAuth credentials are not configured.");
    return { clientId: config.hubspotClientId, clientSecret: config.hubspotClientSecret, scopes: HUBSPOT_SCOPES, authorize: "https://app.hubspot.com/oauth/authorize", token: "https://api.hubapi.com/oauth/v1/token" };
  }
  if (!config.googleClientId || !config.googleClientSecret) throw new Error("Google OAuth credentials are not configured.");
  return { clientId: config.googleClientId, clientSecret: config.googleClientSecret, scopes: provider === "google_gmail" ? GOOGLE_GMAIL_SCOPES : GOOGLE_CALENDAR_SCOPES, authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token" };
}

export function oauthConfigured(provider: OAuthProvider) {
  try { providerConfig(provider); return true; } catch { return false; }
}

export function createAuthorizationUrl(provider: OAuthProvider, agentId: string, workspaceId: string, redirectUri: string) {
  const cfg = providerConfig(provider);
  const state = signState({ agentId, workspaceId, provider, issuedAt: Date.now(), nonce: crypto.randomBytes(24).toString("base64url") });
  const url = new URL(cfg.authorize);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", state);
  if (provider === "google_gmail" || provider === "google_calendar") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
  }
  return url.toString();
}

async function exchangeCode(provider: OAuthProvider, code: string, redirectUri: string): Promise<TokenBundle> {
  const cfg = providerConfig(provider);
  const response = await fetch(cfg.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, code }).toString(), signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") throw new Error(typeof data.error_description === "string" ? data.error_description : `OAuth token exchange failed (${response.status}).`);
  return { accessToken: data.access_token, refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined, expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined, scopes: Array.isArray(data.scope) ? data.scope.filter((item): item is string => typeof item === "string") : typeof data.scope === "string" ? data.scope.split(" ").filter(Boolean) : undefined, accountId: typeof data.hub_id === "number" ? String(data.hub_id) : undefined };
}

async function identify(provider: OAuthProvider, accessToken: string, token: TokenBundle) {
  if (provider === "hubspot") {
    const response = await fetch("https://api.hubapi.com/oauth/v1/access-tokens/" + encodeURIComponent(accessToken), { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { accountId: typeof data.hub_id === "number" ? String(data.hub_id) : token.accountId, accountEmail: typeof data.user === "string" ? data.user : undefined, scopes: Array.isArray(data.scopes) ? data.scopes.filter((item): item is string => typeof item === "string") : token.scopes };
  }
  if (provider === "google_gmail") {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { accountId: typeof data.emailAddress === "string" ? data.emailAddress : undefined, accountEmail: typeof data.emailAddress === "string" ? data.emailAddress : undefined, scopes: token.scopes };
  }
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { accountId: typeof data.id === "string" ? data.id : undefined, accountEmail: typeof data.id === "string" && data.id.includes("@") ? data.id : undefined, scopes: token.scopes };
}

export async function completeOAuth(store: Store, code: string, stateValue: string, redirectUri: string) {
  const state = verifyState(stateValue);
  const agent = await store.getAgent(state.agentId);
  if (!agent || agent.workspaceId !== state.workspaceId) throw new Error("The agent associated with this connection no longer exists.");
  if (agent.level < 3) throw new Error("Level 3 is required to connect tools and external systems.");
  const token = await exchangeCode(state.provider, code, redirectUri);
  const identity = await identify(state.provider, token.accessToken, token);
  const bundle: TokenBundle = { ...token, ...identity };
  const name = state.provider === "hubspot" ? "HubSpot CRM" : state.provider === "google_gmail" ? "Google Gmail" : "Google Calendar";
  const permissions = identity.scopes ?? token.scopes ?? [];
  const connection = await store.createConnection({ agentId: agent.id, workspaceId: state.workspaceId, kind: "native", provider: state.provider, name, authType: "bearer", encryptedSecret: seal(JSON.stringify(bundle)), permissions });
  await store.addAuditEvent({ actorId: state.workspaceId, workspaceId: state.workspaceId, action: "connection.oauth_complete", targetType: "agent", targetId: agent.id, metadata: { provider: state.provider, accountId: bundle.accountId } });
  return connection;
}

export function callbackPage(ok: boolean, message: string) {
  const safe = message.replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
  const frontend = `${config.frontendUrl.replace(/\/$/, "")}/dashboard/products/gbolix-ai-agent`;
  const target = `${frontend}?connection=${ok ? "success" : "error"}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1;url=${target}"><title>Gbolix connection</title></head><body style="font-family:system-ui;padding:40px;text-align:center"><h2>${ok ? "Connection successful" : "Connection failed"}</h2><p>${safe}</p><p>Returning to Gbolix…</p><script>if(window.opener){window.opener.postMessage({type:'gbolix-oauth-result',ok:${ok ? "true" : "false"},message:${JSON.stringify(message)}},'*');window.setTimeout(()=>window.close(),900);}else{window.setTimeout(()=>window.location.replace(${JSON.stringify(target)}),900);}</script></body></html>`;
}

export function providerLabel(provider: OAuthProvider) { return provider === "hubspot" ? "HubSpot CRM" : provider === "google_gmail" ? "Google Gmail" : "Google Calendar"; }
