import crypto from "node:crypto";
import { verifyToken as verifyClerkToken } from "@clerk/backend";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";
import { hash } from "./store.js";
import type { Identity, Store } from "./types.js";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function resolveIdentity(request: { headers: Record<string, string | string[] | undefined> }, store: Store, options?: { allowPublicDeployment?: boolean; requireAdmin?: boolean }): Promise<Identity> {
  const authorization = header(request.headers, "authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Error("Authentication required.");
  const credential = authorization.slice(7).trim();
  if (options?.allowPublicDeployment) {
    const deployment = await store.getDeploymentByToken(credential);
    if (deployment) return { subject: `deployment:${deployment.deployment.id}`, workspaceId: deployment.agent.workspaceId, authType: "deployment" };
  }
  const apiKey = await store.getApiKeyByHash(hash(credential));
  if (apiKey) return { subject: `api-key:${apiKey.id}`, workspaceId: apiKey.workspaceId, authType: "api-key" };
  const identity = await verifyIdentityToken(credential);
  if (options?.requireAdmin && !identity.isAdmin) throw new Error("Admin access required.");
  return identity;
}

export function resolveInternalIdentity(request: { headers: Record<string, string | string[] | undefined> }): Identity {
  const token = header(request.headers, "x-gbolix-internal-token");
  if (!token || !config.platformToken || !safeEqual(token, config.platformToken)) throw new Error("Internal authentication required.");
  return { subject: "gbolix-platform", workspaceId: "platform", authType: "internal", isAdmin: true };
}

async function verifyIdentityToken(token: string): Promise<Identity> {
  if (config.agentJwtSecret) {
    const verified = await jwtVerify(token, new TextEncoder().encode(config.agentJwtSecret), { algorithms: ["HS256"] });
    return claimsToIdentity(verified.payload);
  }
  if (config.clerkSecretKey) {
    const verified = await verifyClerkToken(token, { secretKey: config.clerkSecretKey });
    return claimsToIdentity(verified);
  }
  const jwksUrl = process.env.CLERK_JWKS_URL;
  if (jwksUrl) {
    jwks ??= createRemoteJWKSet(new URL(jwksUrl));
    const verified = await jwtVerify(token, jwks);
    return claimsToIdentity(verified.payload);
  }
  if (process.env.NODE_ENV === "production") throw new Error("Identity verification is not configured.");
  return claimsToIdentity(decodeJwt(token));
}

function claimsToIdentity(payload: Record<string, unknown>): Identity {
  const subject = String(payload.sub ?? "");
  if (!subject) throw new Error("Identity token has no subject.");
  const workspaceId = String(payload.workspace_id ?? payload.org_id ?? payload.workspaceId ?? subject);
  const role = typeof payload.role === "string" ? payload.role : undefined;
  return { subject, workspaceId, workspaceKey: typeof payload.workspace_key === "string" ? payload.workspace_key : undefined, role, email: typeof payload.email === "string" ? payload.email : undefined, isAdmin: role === "owner" || role === "admin" || config.adminUserIds.has(subject), authType: "identity" };
}

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid bearer token.");
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>; } catch { throw new Error("Invalid bearer token."); }
}
function header(headers: Record<string, string | string[] | undefined>, key: string): string | undefined { const value = headers[key] ?? headers[key.toLowerCase()]; return Array.isArray(value) ? value[0] : value; }
function safeEqual(a: string, b: string) { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && crypto.timingSafeEqual(left, right); }
