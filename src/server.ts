import crypto from "node:crypto";
import cors from "cors";
import { lookup } from "node:dns/promises";
import { createClerkClient } from "@clerk/backend";
import { PDFParse } from "pdf-parse";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, isProductionConfig } from "./config.js";
import { resolveIdentity, resolveInternalIdentity } from "./auth.js";
import { CreditError, CreditService } from "./credits.js";
import { AgentRuntime } from "./runtime.js";
import { clearProviderModelCache, encryptProviderApiKey, publicAIError, resolveAiProviders } from "./provider.js";
import { BUILTIN_TOOLS } from "./tools.js";
import { createStore, hash } from "./store.js";
import { callbackPage, completeOAuth, createAuthorizationUrl, oauthConfigured, type OAuthProvider } from "./oauth.js";
import type { Agent, AgentConnection, AiProviderAdapter, ConversationStatus, Identity } from "./types.js";
import { encryptGmailCredentials, GmailTestEmailError, sendGmailTestEmail } from "./testEmail.js";
import { approveReply, createCampaign, pollAgentReplies, pollAllConfiguredAgents, publicEmailError, runCampaign } from "./emailAutomation.js";
import { loadAiProviderCatalog } from "./aiCatalog.js";

const store = await createStore();
const credits = new CreditService();
const runtime = new AgentRuntime(store, credits);
const clerkClient = config.clerkSecretKey ? createClerkClient({ secretKey: config.clerkSecretKey }) : undefined;
const messageRateLimits = new Map<string, { windowStart: number; count: number }>();
const app = express();

app.use(async (request, response, next) => {
  const origin = request.header("origin");
  const requestOrigin = `${request.header("x-forwarded-proto")?.split(",")[0]?.trim() ?? request.protocol}://${request.get("host")}`;
  if (!origin || origin === requestOrigin || config.corsOrigins.includes(origin) || (!isProductionConfig() && config.corsOrigins.length === 0)) return allowCors(request, response, next, origin);
  const token = bearerToken(request);
  const deployment = token ? await store.getDeploymentByToken(token).catch(() => undefined) : undefined;
  if (deployment?.deployment.allowedOrigin === origin) return allowCors(request, response, next, origin);
  if (request.method === "OPTIONS") return response.status(403).end();
  return response.status(403).json({ error: "This deployment is not enabled for this website origin." });
});
app.use(express.json({ limit: "1mb" }));
app.use((request, response, next) => { response.setHeader("x-request-id", request.header("x-request-id") ?? `http_${crypto.randomBytes(8).toString("hex")}`); next(); });

app.get("/healthz", (_request, response) => response.json({ status: "ok", timestamp: new Date().toISOString(), storage: config.databaseUrl ? "postgres" : "memory", creditMode: config.creditMode }));
app.get("/widget.js", (_request, response) => { response.type("application/javascript").send(widgetScript()); });
app.get("/widget", (request, response) => { const agentId = typeof request.query.agent === "string" ? request.query.agent : undefined; const token = typeof request.query.token === "string" ? request.query.token : undefined; if (!agentId || !token) return response.status(400).type("text").send("This hosted agent link is incomplete."); return response.type("html").send(widgetHtml(agentId, token)); });

app.post("/v1/agents", withIdentity(async (request, response, identity) => {
  const body = request.body as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim() || typeof body.instructions !== "string" || !body.instructions.trim()) return response.status(400).json({ error: "name and instructions are required" });
  const requestedLevel = Number(body.level ?? 1);
  if (![1, 2, 3].includes(requestedLevel)) return response.status(400).json({ error: "level must be 1, 2, or 3" });
  if (requestedLevel !== 1) {
    const entitlement = await verifyPaidLevelEntitlement(identity, requestedLevel);
    if (!entitlement.allowed) return response.status(402).json({ error: "A verified Level 2 or Level 3 subscription is required before creating this agent.", code: "SUBSCRIPTION_REQUIRED", level: requestedLevel, currentLevel: entitlement.currentLevel });
  }
  const agent = await store.createAgent({ workspaceId: identity.workspaceId, name: body.name.trim(), description: typeof body.description === "string" ? body.description : "", instructions: body.instructions.trim(), tone: typeof body.tone === "string" ? body.tone : "warm, concise, and helpful", model: typeof body.model === "string" ? body.model : config.defaultModel, level: requestedLevel as Agent["level"], status: body.status === "active" ? "active" : "draft", welcomeMessage: typeof body.welcomeMessage === "string" ? body.welcomeMessage : "Hi! How can I help you today?", enabledTools: normalizeEnabledTools(requestedLevel, body.enabledTools) ?? [] });
  await store.createAgentVersion({ agentId: agent.id, workspaceId: agent.workspaceId, version: 1, config: versionConfig(agent), createdBy: identity.subject });
  return response.status(201).json(agent);
}));
app.get("/v1/agents", withIdentity(async (_request, response, identity) => response.json(await store.listAgents(identity.workspaceId))));
app.get("/v1/agents/:agentId", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); return response.json(agent); }, { allowPublicDeployment: true }));
app.patch("/v1/agents/:agentId", withIdentity(async (request, response, identity) => { const patch = request.body as any; const currentAgent = await store.getAgent(String(request.params.agentId)); if (currentAgent && Array.isArray(patch.enabledTools) && patch.enabledTools.length > 0 && currentAgent.level < 3) return response.status(402).json({ error: "Level 3 is required to enable tools.", code: "LEVEL_REQUIRED", level: 3 }); const agent = await store.updateAgent(String(request.params.agentId), identity.workspaceId, { name: typeof patch.name === "string" ? patch.name.trim() : undefined, description: typeof patch.description === "string" ? patch.description : undefined, instructions: typeof patch.instructions === "string" ? patch.instructions : undefined, tone: typeof patch.tone === "string" ? patch.tone : undefined, model: typeof patch.model === "string" ? patch.model : undefined, status: ["draft", "active", "paused", "disabled"].includes(patch.status) ? patch.status : undefined, welcomeMessage: typeof patch.welcomeMessage === "string" ? patch.welcomeMessage : undefined, enabledTools: normalizeEnabledTools(currentAgent?.level ?? 1, patch.enabledTools) }); if (!agent) return response.status(404).json({ error: "Agent not found" }); const versions = await store.listAgentVersions(agent.id, identity.workspaceId); await store.createAgentVersion({ agentId: agent.id, workspaceId: agent.workspaceId, version: (versions[0]?.version ?? 0) + 1, config: versionConfig(agent), createdBy: identity.subject }); await store.addAuditEvent({ actorId: identity.subject, workspaceId: agent.workspaceId, action: "agent.update", targetType: "agent", targetId: agent.id, metadata: { version: (versions[0]?.version ?? 0) + 1 } }); return response.json(agent); }));
app.post("/v1/agents/:agentId/upgrade", withIdentity(async (request, response, identity) => { const current = await store.getAgent(String(request.params.agentId)); if (!current || current.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); const requestedLevel = Number((request.body as Record<string, unknown>)?.level ?? 1); if (![1, 2, 3].includes(requestedLevel) || requestedLevel <= current.level) return response.status(400).json({ error: "Requested level must be higher than the current agent level and must be 1, 2, or 3" }); const entitlement = await verifyPaidLevelEntitlement(identity, requestedLevel); if (!entitlement.allowed) return response.status(402).json({ error: "A verified subscription is required before upgrading this agent.", code: "SUBSCRIPTION_REQUIRED", level: requestedLevel, currentLevel: entitlement.currentLevel }); const updated = await store.updateAgent(current.id, identity.workspaceId, { level: requestedLevel as Agent["level"] }); if (!updated) return response.status(404).json({ error: "Agent not found" }); const versions = await store.listAgentVersions(updated.id, identity.workspaceId); await store.createAgentVersion({ agentId: updated.id, workspaceId: updated.workspaceId, version: (versions[0]?.version ?? 0) + 1, config: versionConfig(updated), createdBy: identity.subject }); await store.addAuditEvent({ actorId: identity.subject, workspaceId: updated.workspaceId, action: "agent.upgrade", targetType: "agent", targetId: updated.id, metadata: { previousLevel: current.level, newLevel: updated.level } }); return response.json(updated); }));
app.delete("/v1/agents/:agentId", withIdentity(async (request, response, identity) => { const agent = await store.updateAgent(String(request.params.agentId), identity.workspaceId, { status: "disabled" }); if (!agent) return response.status(404).json({ error: "Agent not found" }); const versions = await store.listAgentVersions(agent.id, identity.workspaceId); await store.createAgentVersion({ agentId: agent.id, workspaceId: agent.workspaceId, version: (versions[0]?.version ?? 0) + 1, config: versionConfig(agent), createdBy: identity.subject }); return response.json(agent); }));

app.get("/v1/agents/:agentId/versions", withIdentity(async (request, response, identity) => response.json(await store.listAgentVersions(String(request.params.agentId), identity.workspaceId))));
app.post("/v1/agents/:agentId/versions/:versionId/restore", withIdentity(async (request, response, identity) => { const restored = await store.restoreAgentVersion(String(request.params.versionId), String(request.params.agentId), identity.workspaceId); if (!restored) return response.status(404).json({ error: "Agent version not found" }); const versions = await store.listAgentVersions(restored.id, identity.workspaceId); await store.createAgentVersion({ agentId: restored.id, workspaceId: restored.workspaceId, version: (versions[0]?.version ?? 0) + 1, config: versionConfig(restored), createdBy: identity.subject }); await store.addAuditEvent({ actorId: identity.subject, workspaceId: restored.workspaceId, action: "agent.restore_version", targetType: "agent", targetId: restored.id, metadata: { restoredVersionId: request.params.versionId } }); return response.json(restored); }));
app.get("/v1/agents/:agentId/knowledge", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); return response.json(agent.level >= 2 ? await store.listKnowledge(agent.id, identity.workspaceId) : []); }));
app.post("/v1/agents/:agentId/knowledge", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); if (agent.level < 2) return response.status(402).json({ error: "Level 2 is required to add business knowledge.", code: "LEVEL_REQUIRED", level: 2 }); const body = request.body as any; if (typeof body.title !== "string" || typeof body.content !== "string" || !body.title.trim() || !body.content.trim()) return response.status(400).json({ error: "title and content are required" }); return response.status(201).json(await store.addKnowledge({ agentId: agent.id, workspaceId: identity.workspaceId, title: body.title.trim(), content: body.content.trim(), sourceType: body.sourceType === "url" ? "url" : "text", status: "ready" })); }));
app.post("/v1/agents/:agentId/knowledge/import-file", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); if (agent.level < 2) return response.status(402).json({ error: "Level 2 is required to import business knowledge.", code: "LEVEL_REQUIRED", level: 2 }); const body = request.body as Record<string, unknown>; const filename = typeof body.filename === "string" ? body.filename.trim().slice(0, 180) : ""; const mimeType = typeof body.mimeType === "string" ? body.mimeType.toLowerCase() : ""; const encoded = typeof body.contentBase64 === "string" ? body.contentBase64 : ""; if (!filename || !encoded) return response.status(400).json({ error: "filename and contentBase64 are required" }); if (encoded.length > 1400000) return response.status(413).json({ error: "File is too large. Please upload a document under 1 MB." }); let content = ""; try { const buffer = Buffer.from(encoded, "base64"); if (!buffer.length) return response.status(400).json({ error: "The uploaded file was empty." }); if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) { if (buffer.subarray(0, 4).toString() !== "%PDF") return response.status(415).json({ error: "The uploaded file is not a valid PDF." }); const parser = new PDFParse({ data: buffer }); try { const result = await parser.getText(); content = result.text; } finally { await parser.destroy(); } } else if (["text/plain", "text/markdown", "text/csv", "application/json"].includes(mimeType) || /\\.(txt|md|csv|json)$/i.test(filename)) { content = buffer.toString("utf8"); } else return response.status(415).json({ error: "Supported file types are PDF, TXT, Markdown, CSV, and JSON." }); } catch { return response.status(422).json({ error: "The file could not be read. Please try another document." }); } content = content.replace(/[ \\t\\n\\r]+/g, " ").trim().slice(0, 200000); if (content.length < 20) return response.status(422).json({ error: "The file did not contain enough readable text to import." }); return response.status(201).json(await store.addKnowledge({ agentId: agent.id, workspaceId: identity.workspaceId, title: filename, content, sourceType: "file", status: "ready" })); }));
app.post("/v1/agents/:agentId/knowledge/import-url", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); if (agent.level < 2) return response.status(402).json({ error: "Level 2 is required to import business knowledge.", code: "LEVEL_REQUIRED", level: 2 }); const body = request.body as Record<string, unknown>; const rawUrl = typeof body.url === "string" ? body.url.trim() : ""; const target = await safeKnowledgeUrl(rawUrl); if (!target) return response.status(400).json({ error: "url must be a public http(s) URL" }); const fetched = await fetch(target.toString(), { redirect: "manual", headers: { accept: "text/html,text/plain", "user-agent": "Gbolix-AI-Agent-Knowledge/1.0" }, signal: AbortSignal.timeout(8000) }); if (!fetched.ok || fetched.status >= 300 && fetched.status < 400) return response.status(422).json({ error: "The knowledge URL could not be fetched without a redirect." }); const contentType = fetched.headers.get("content-type") ?? ""; if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return response.status(415).json({ error: "Only HTML and plain-text URLs are supported in this import." }); const raw = (await fetched.text()).slice(0, 200000); const content = stripHtml(raw); if (content.length < 20) return response.status(422).json({ error: "The URL did not contain enough readable text to import." }); const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : target.hostname; return response.status(201).json(await store.addKnowledge({ agentId: agent.id, workspaceId: identity.workspaceId, title, content, sourceType: "url", status: "ready" })); }));
app.delete("/v1/agents/:agentId/knowledge/:knowledgeId", withIdentity(async (request, response, identity) => { const removed = await store.deleteKnowledge(String(request.params.knowledgeId), String(request.params.agentId), identity.workspaceId); return removed ? response.status(204).send() : response.status(404).json({ error: "Knowledge source not found" }); }));

app.post("/v1/agents/:agentId/messages", withIdentity(async (request, response, identity) => { const limit = consumeMessageRateLimit(`${identity.workspaceId}:${identity.subject}`); if (!limit.allowed) { response.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000))); return response.status(429).json({ error: "Too many agent requests. Please retry shortly.", code: "RATE_LIMITED" }); } try { return response.json(await runtime.run(String(request.params.agentId), identity, request.body)); } catch (error) { if (error instanceof CreditError && error.code === "INSUFFICIENT_CREDITS") return response.status(402).json({ error: error.message, code: error.code }); throw error; } }, { allowPublicDeployment: true }));

app.post("/v1/agents/:agentId/test-email", withIdentity(async (request, response, identity) => {
  const requestId = String(response.getHeader("x-request-id") ?? `test_email_${crypto.randomBytes(8).toString("hex")}`);
  const agentId = String(request.params.agentId);
  const log = (stage: string, fields: Record<string, unknown> = {}) => console.info("[Gbolix test-email]", JSON.stringify({ requestId, stage, agentId, workspaceId: identity.workspaceId, ...fields }));
  log("request_received", { authType: identity.authType });
  try {
    const agent = await store.getAgent(agentId);
    log("agent_loaded", { found: Boolean(agent), level: agent?.level, status: agent?.status });
    if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found", message: "Agent not found", code: "AGENT_NOT_FOUND", requestId });
    if (agent.level < 3) return response.status(402).json({ error: "Level 3 is required to send test emails.", message: "Level 3 is required to send test emails.", code: "LEVEL_REQUIRED", level: 3, requestId });
    const body = request.body as Record<string, unknown>;
    const to = typeof body.to === "string" ? body.to.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    log("request_validating", { hasRecipient: Boolean(to), hasSubject: Boolean(subject), messageLength: message.length });
    if (!to || !subject || !message) return response.status(400).json({ error: "to, subject, and message are required", message: "to, subject, and message are required", code: "TEST_EMAIL_FIELDS_REQUIRED", requestId });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return response.status(400).json({ error: "A valid recipient email address is required", message: "A valid recipient email address is required", code: "INVALID_RECIPIENT", requestId });
    if (subject.length > 998 || message.length > 100000) return response.status(400).json({ error: "Email subject or message is too long.", message: "Email subject or message is too long.", code: "TEST_EMAIL_TOO_LONG", requestId });
    if (/[\r\n]/.test(to) || /[\r\n]/.test(subject)) return response.status(400).json({ error: "Email headers contain invalid characters.", message: "Email headers contain invalid characters.", code: "INVALID_EMAIL_HEADERS", requestId });

    const connections = await store.listConnections(agent.id, identity.workspaceId);
    const gmailCandidates = connections.filter((item) => item.provider === "google_gmail");
    log("connections_loaded", { total: connections.length, gmailCandidates: gmailCandidates.length, connectedGmailCandidates: gmailCandidates.filter((item) => item.status === "connected").length });
    const gmail = gmailCandidates.find((item) => item.status === "connected");
    if (!gmail) {
      const error = gmailCandidates.length ? "Gmail is not connected for this agent. Reconnect Google Gmail in Tools & Connections before sending a test email." : "Gmail is not connected for this agent. Connect Google Gmail in Tools & Connections before sending a test email.";
      log("gmail_connection_missing", { candidateStatuses: gmailCandidates.map((item) => item.status) });
      return response.status(409).json({ error, message: error, code: "GMAIL_NOT_CONNECTED", requestId });
    }

    const connection = await store.getConnection(gmail.id, agent.id, identity.workspaceId);
    log("connection_loaded", { connectionId: gmail.id, found: Boolean(connection), hasEncryptedSecret: Boolean(connection?.encryptedSecret), permissionCount: connection?.permissions.length ?? 0 });
    if (!connection) {
      const error = "The Gmail connection could not be loaded for this agent. Please reconnect Gmail.";
      return response.status(409).json({ error, message: error, code: "GMAIL_CONNECTION_UNAVAILABLE", requestId });
    }

    const sent = await sendGmailTestEmail(connection, { to, subject, message }, {
      requestId,
      agentId: agent.id,
      workspaceId: identity.workspaceId,
      onTokenRefreshed: async (bundle) => {
        log("persisting_refreshed_credentials", { connectionId: connection.id, expiresAt: bundle.expiresAt });
        const updated = await store.updateConnectionSecret(connection.id, agent.id, identity.workspaceId, encryptGmailCredentials(bundle));
        if (!updated) throw new Error("The Gmail connection no longer exists.");
      },
    });
    log("email_send_completed", { connectionId: connection.id, messageId: sent.id, threadId: sent.threadId });
    await store.addAuditEvent({ actorId: identity.subject, workspaceId: agent.workspaceId, action: "agent.test_email", targetType: "agent", targetId: agent.id, metadata: { recipient: to, subject, provider: "google_gmail", messageId: sent.id, requestId } });
    log("audit_recorded", { connectionId: connection.id });
    return response.json({ success: true, messageId: sent.id, threadId: sent.threadId, from: sent.from, requestId });
  } catch (error) {
    if (error instanceof GmailTestEmailError) {
      console.error("[Gbolix test-email] request_failed", JSON.stringify({ requestId, agentId, workspaceId: identity.workspaceId, stage: error.stage, code: error.code, status: error.status, error: error.message }));
      return response.status(error.status).json({ error: error.message, message: error.message, code: error.code, stage: error.stage, requestId });
    }
    const message = error instanceof Error ? error.message : "Unexpected Gmail test email failure.";
    console.error("[Gbolix test-email] request_failed", JSON.stringify({ requestId, agentId, workspaceId: identity.workspaceId, stage: "unexpected", error: message, stack: error instanceof Error ? error.stack : undefined }));
    return response.status(500).json({ error: message, message, code: "GMAIL_TEST_EMAIL_UNEXPECTED_ERROR", stage: "unexpected", requestId });
  }
}));
app.get("/v1/agents/:agentId/conversations", withIdentity(async (request, response, identity) => response.json(await store.listConversations(String(request.params.agentId), identity.workspaceId))));
app.get("/v1/conversations/:conversationId", withIdentity(async (request, response, identity) => { const conversation = await store.getConversation(String(request.params.conversationId), identity.workspaceId); if (!conversation) return response.status(404).json({ error: "Conversation not found" }); return response.json({ conversation, messages: await store.listMessages(conversation.id) }); }));
app.patch("/v1/conversations/:conversationId", withIdentity(async (request, response, identity) => { const conversation = await store.getConversation(String(request.params.conversationId), identity.workspaceId); if (!conversation) return response.status(404).json({ error: "Conversation not found" }); const status = String((request.body as Record<string, unknown>)?.status ?? ""); if (!["open", "resolved", "handoff"].includes(status)) return response.status(400).json({ error: "status must be open, resolved, or handoff" }); await store.touchConversation(conversation.id, status as ConversationStatus); const updated = await store.getConversation(conversation.id, identity.workspaceId); return response.json(updated); }));

app.post("/v1/agents/:agentId/deployments", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); const body = request.body as any; const allowedOrigin = typeof body.allowedOrigin === "string" ? normalizeOrigin(body.allowedOrigin) : undefined; if (body.allowedOrigin && !allowedOrigin) return response.status(400).json({ error: "allowedOrigin must be a valid website origin such as https://example.com" }); const deployment = await store.createDeployment({ agentId: agent.id, workspaceId: identity.workspaceId, channel: "website", allowedOrigin, tokenPrefix: "", status: "active" }); const shareableLink = `${publicBaseUrl(request)}/widget?agent=${encodeURIComponent(agent.id)}&token=${encodeURIComponent(deployment.plaintextToken ?? "")}`; return response.status(201).json({ deployment, shareableLink, embedCode: `<script src="${publicBaseUrl(request)}/widget.js" data-gbolix-agent="${agent.id}" data-gbolix-token="${deployment.plaintextToken}" async></script>` }); }));
app.get("/v1/agents/:agentId/deployments", withIdentity(async (request, response, identity) => response.json(await store.listDeployments(String(request.params.agentId), identity.workspaceId))));
app.get("/v1/agents/:agentId/deployments/:deploymentId/artifacts", withIdentity(async (request, response, identity) => {
  const agentId = String(request.params.agentId);
  const deploymentId = String(request.params.deploymentId);
  const agent = await store.getAgent(agentId);
  if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" });
  const artifact = await store.getDeploymentArtifact(deploymentId, agentId, identity.workspaceId);
  if (!artifact) return response.status(404).json({ error: "Active deployment not found" });
  const baseUrl = publicBaseUrl(request);
  const shareableLink = `${baseUrl}/widget?agent=${encodeURIComponent(agentId)}&token=${encodeURIComponent(artifact.plaintextToken)}`;
  response.setHeader("Cache-Control", "no-store");
  return response.json({ deployment: artifact.deployment, shareableLink, embedCode: `<script src="${baseUrl}/widget.js" data-gbolix-agent="${agentId}" data-gbolix-token="${artifact.plaintextToken}" async></script>` });
}));
app.delete("/v1/agents/:agentId/deployments/:deploymentId", withIdentity(async (request, response, identity) => { const removed = await store.revokeDeployment(String(request.params.deploymentId), String(request.params.agentId), identity.workspaceId); return removed ? response.status(204).send() : response.status(404).json({ error: "Deployment not found" }); }));

app.get("/v1/agents/:agentId/connections/oauth/:provider/start", withIdentity(async (request, response, identity) => {
  const provider = String(request.params.provider) as OAuthProvider;
  if (!["hubspot", "google_gmail", "google_calendar"].includes(provider)) return response.status(400).json({ error: "Unsupported OAuth provider" });
  const agent = await store.getAgent(String(request.params.agentId));
  if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" });
  if (agent.level < 3) return response.status(402).json({ error: "Level 3 is required to connect tools and external systems.", code: "LEVEL_REQUIRED", level: 3 });
  if (!oauthConfigured(provider)) return response.status(503).json({ error: `${provider} OAuth is not configured on the server.`, code: "OAUTH_PROVIDER_NOT_CONFIGURED" });
  const redirectUri = `${publicBaseUrl(request)}/v1/oauth/${provider}/callback`;
  return response.json({ provider, authorizationUrl: createAuthorizationUrl(provider, agent.id, identity.workspaceId, redirectUri), redirectUri });
}));

for (const provider of ["hubspot", "google_gmail", "google_calendar"] as const) {
  app.get(`/v1/oauth/${provider}/callback`, async (request, response) => {
    try {
      const error = typeof request.query.error === "string" ? request.query.error : undefined;
      if (error) return response.status(400).type("html").send(callbackPage(false, `Authorization was not completed: ${error}`));
      const code = typeof request.query.code === "string" ? request.query.code : "";
      const state = typeof request.query.state === "string" ? request.query.state : "";
      if (!code || !state) return response.status(400).type("html").send(callbackPage(false, "The OAuth callback was missing the authorization code or state."));
      const redirectUri = `${publicBaseUrl(request)}/v1/oauth/${provider}/callback`;
      await completeOAuth(store, code, state, redirectUri);
      return response.type("html").send(callbackPage(true, "The connection is now active. You can close this window and return to Gbolix."));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to complete the OAuth connection.";
      return response.status(400).type("html").send(callbackPage(false, message));
    }
  });
}
app.get("/v1/agents/:agentId/connections", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); return response.json(agent.level >= 3 ? await store.listConnections(agent.id, identity.workspaceId) : []); }));
app.post("/v1/agents/:agentId/connections", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); if (agent.level < 3) return response.status(402).json({ error: "Level 3 is required to connect tools and external systems.", code: "LEVEL_REQUIRED", level: 3 }); const body = request.body as Record<string, unknown>; const kind = body.kind === "custom_api" ? "custom_api" : body.kind === "native" ? "native" : undefined; const provider = typeof body.provider === "string" ? body.provider.trim().slice(0, 80) : ""; const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : ""; if (!kind || !provider || !name) return response.status(400).json({ error: "kind, provider, and name are required" }); if (kind === "native") return response.status(501).json({ error: "Native OAuth connections are not enabled yet. Configure a Custom API connection or add the provider OAuth credentials first.", code: "OAUTH_PROVIDER_NOT_CONFIGURED" }); const rawEndpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : ""; const endpoint = await safeKnowledgeUrl(rawEndpoint); if (!endpoint) return response.status(400).json({ error: "endpoint must be a public http(s) URL" }); const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(body.method).toUpperCase()) ? String(body.method).toUpperCase() as AgentConnection["method"] : "GET"; const authType = body.authType === "api_key" || body.authType === "bearer" ? body.authType : "none"; const secret = typeof body.secret === "string" ? body.secret : ""; if (authType !== "none" && !secret) return response.status(400).json({ error: "A secret is required for API key or Bearer authentication" }); const headers = safeStringMap(body.headers); const parameters = safeStringMap(body.parameters); const encryptedSecret = secret ? sealSecret(secret) : undefined; const connection = await store.createConnection({ agentId: agent.id, workspaceId: identity.workspaceId, kind, provider, name, endpoint: endpoint.toString(), method, authType, encryptedSecret, headers, parameters, permissions: Array.isArray(body.permissions) ? body.permissions.filter((item): item is string => typeof item === "string").slice(0, 10) : [] }); await store.addAuditEvent({ actorId: identity.subject, workspaceId: agent.workspaceId, action: "connection.create", targetType: "agent", targetId: agent.id, metadata: { kind, provider } }); return response.status(201).json(connection); }));
app.delete("/v1/agents/:agentId/connections/:connectionId", withIdentity(async (request, response, identity) => { const removed = await store.deleteConnection(String(request.params.connectionId), String(request.params.agentId), identity.workspaceId); return removed ? response.status(204).send() : response.status(404).json({ error: "Connection not found" }); }));

app.get("/v1/admin/ai/providers", withIdentity(async (_request, response) => {
  const providers = await store.listAiProviders();
  const catalogs = await loadAiProviderCatalog(await resolveAiProviders(store));
  return response.json({ providers, catalogs });
}, { requireAdmin: true }));
app.post("/v1/admin/ai/providers", withIdentity(async (request, response, identity) => {
  const input = await parseAdminProviderInput(request.body as Record<string, unknown>);
  if (!input.ok) return response.status(input.status).json({ error: input.error, code: "AI_PROVIDER_INVALID" });
  if (await store.getAiProvider(input.value.id)) return response.status(409).json({ error: "A provider with this identifier already exists.", code: "AI_PROVIDER_EXISTS" });
  const provider = await store.upsertAiProvider({ id: input.value.id, name: input.value.name, adapter: input.value.adapter, baseUrl: input.value.baseUrl, defaultModel: input.value.defaultModel, priority: input.value.priority, enabled: input.value.enabled, encryptedApiKey: encryptProviderApiKey(input.value.apiKey) });
  clearProviderModelCache(provider.id);
  await store.addAuditEvent({ actorId: identity.subject, workspaceId: identity.workspaceId, action: "ai.provider.create", targetType: "ai_provider", targetId: provider.id, metadata: { adapter: provider.adapter, enabled: provider.enabled, priority: provider.priority } });
  return response.status(201).json(provider);
}, { requireAdmin: true }));
app.patch("/v1/admin/ai/providers/:providerId", withIdentity(async (request, response, identity) => {
  const providerId = String(request.params.providerId);
  const current = await store.getAiProvider(providerId);
  if (!current) return response.status(404).json({ error: "AI provider not found.", code: "AI_PROVIDER_NOT_FOUND" });
  const input = await parseAdminProviderInput(request.body as Record<string, unknown>, providerId, current);
  if (!input.ok) return response.status(input.status).json({ error: input.error, code: "AI_PROVIDER_INVALID" });
  const updated = await store.upsertAiProvider({ id: input.value.id, name: input.value.name, adapter: input.value.adapter, baseUrl: input.value.baseUrl, defaultModel: input.value.defaultModel, priority: input.value.priority, enabled: input.value.enabled, encryptedApiKey: input.value.apiKey ? encryptProviderApiKey(input.value.apiKey) : undefined });
  clearProviderModelCache(updated.id);
  await store.addAuditEvent({ actorId: identity.subject, workspaceId: identity.workspaceId, action: "ai.provider.update", targetType: "ai_provider", targetId: updated.id, metadata: { adapter: updated.adapter, enabled: updated.enabled, priority: updated.priority, apiKeyRotated: Boolean(input.value.apiKey) } });
  return response.json(updated);
}, { requireAdmin: true }));
app.delete("/v1/admin/ai/providers/:providerId", withIdentity(async (request, response, identity) => {
  const providerId = String(request.params.providerId);
  const removed = await store.deleteAiProvider(providerId);
  clearProviderModelCache(providerId);
  if (!removed) return response.status(404).json({ error: "AI provider not found.", code: "AI_PROVIDER_NOT_FOUND" });
  await store.addAuditEvent({ actorId: identity.subject, workspaceId: identity.workspaceId, action: "ai.provider.delete", targetType: "ai_provider", targetId: providerId, metadata: {} });
  return response.status(204).send();
}, { requireAdmin: true }));
app.post("/v1/admin/ai/providers/:providerId/models/refresh", withIdentity(async (request, response) => {
  const providerId = String(request.params.providerId);
  const configured = await store.getAiProvider(providerId);
  if (!configured) return response.status(404).json({ error: "AI provider not found.", code: "AI_PROVIDER_NOT_FOUND" });
  const runtimeProvider = (await resolveAiProviders(store) ?? []).find((item) => item.id === providerId);
  if (!runtimeProvider) return response.status(409).json({ error: "This provider is not available. Check that it is enabled and its secret is configured.", code: "AI_PROVIDER_UNAVAILABLE" });
  const catalog = (await loadAiProviderCatalog([runtimeProvider]))[0];
  return response.json(catalog);
}, { requireAdmin: true }));
app.get("/v1/agents/:agentId/email/settings", withIdentity(async (request, response, identity) => {
  const agent = await store.getAgent(String(request.params.agentId));
  if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" });
  if (agent.level < 3) return response.status(402).json({ error: "Level 3 is required for email automation.", code: "LEVEL_REQUIRED", level: 3 });
  return response.json(await store.getEmailSettings(agent.id, identity.workspaceId) ?? { agentId: agent.id, workspaceId: agent.workspaceId, replyMode: "off", replyScope: "agent_sent", matchingQuery: "", updatedAt: new Date(0).toISOString() });
}));
app.patch("/v1/agents/:agentId/email/settings", withIdentity(async (request, response, identity) => {
  const agent = await store.getAgent(String(request.params.agentId));
  if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" });
  if (agent.level < 3) return response.status(402).json({ error: "Level 3 is required for email automation.", code: "LEVEL_REQUIRED", level: 3 });
  const body = request.body as Record<string, unknown>;
  const replyMode = ["off", "draft", "automatic"].includes(String(body.replyMode)) ? String(body.replyMode) as "off" | "draft" | "automatic" : undefined;
  const replyScope = ["agent_sent", "matching_rules", "both"].includes(String(body.replyScope)) ? String(body.replyScope) as "agent_sent" | "matching_rules" | "both" : undefined;
  if (!replyMode || !replyScope) return response.status(400).json({ error: "replyMode must be off, draft, or automatic, and replyScope must be agent_sent, matching_rules, or both." });
  if (replyMode !== "off" && !agent.enabledTools.includes("send_email")) return response.status(403).json({ error: "Enable the approved Send email action in Configure before enabling reply automation.", code: "EMAIL_ACTION_NOT_APPROVED" });
  const settings = await store.upsertEmailSettings({ agentId: agent.id, workspaceId: agent.workspaceId, replyMode, replyScope, matchingQuery: typeof body.matchingQuery === "string" ? body.matchingQuery.trim().slice(0, 300) : "" });
  await store.addAuditEvent({ actorId: identity.subject, workspaceId: agent.workspaceId, action: "email.settings.update", targetType: "agent", targetId: agent.id, metadata: { replyMode, replyScope } });
  return response.json(settings);
}));
app.post("/v1/agents/:agentId/email/campaigns", withIdentity(async (request, response, identity) => {
  const agent = await store.getAgent(String(request.params.agentId));
  if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" });
  if (agent.level < 3) return response.status(402).json({ error: "Level 3 is required for bulk email campaigns.", code: "LEVEL_REQUIRED", level: 3 });
  if (!agent.enabledTools.includes("send_email")) return response.status(403).json({ error: "Enable the approved Send email action in Configure before creating a bulk campaign.", code: "EMAIL_ACTION_NOT_APPROVED" });
  const body = request.body as Record<string, unknown>;
  const csv = typeof body.csv === "string" ? body.csv : "";
  if (csv.length > 700000) return response.status(413).json({ error: "CSV is too large. Please upload a file under 500 KB." });
  try {
    const result = await createCampaign(store, agent, { csv, subjectTemplate: typeof body.subjectTemplate === "string" ? body.subjectTemplate : "", bodyTemplate: typeof body.bodyTemplate === "string" ? body.bodyTemplate : "", messageMode: body.messageMode === "per_row" ? "per_row" : "shared" });
    await store.addAuditEvent({ actorId: identity.subject, workspaceId: agent.workspaceId, action: "email.campaign.create", targetType: "agent", targetId: agent.id, metadata: { campaignId: result.campaign.id, totalRows: result.campaign.totalRows, messageMode: result.campaign.messageMode } });
    return response.status(201).json({ campaign: result.campaign, preview: result.rows.slice(0, 20) });
  } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : "The CSV campaign could not be created.", code: "EMAIL_CAMPAIGN_INVALID" }); }
}));
app.get("/v1/agents/:agentId/email/campaigns", withIdentity(async (request, response, identity) => response.json(await store.listEmailCampaigns(String(request.params.agentId), identity.workspaceId, 50))));
app.get("/v1/agents/:agentId/email/campaigns/:campaignId", withIdentity(async (request, response, identity) => { const campaign = await store.getEmailCampaign(String(request.params.campaignId), String(request.params.agentId), identity.workspaceId); if (!campaign) return response.status(404).json({ error: "Email campaign not found" }); const rows = await store.listEmailCampaignRows(campaign.id, 1000); return response.json({ campaign, rows: rows.map((row) => row.error ? { ...row, error: publicEmailError(row.error) } : row) }); }));
app.post("/v1/agents/:agentId/email/campaigns/:campaignId/start", withIdentity(async (request, response, identity) => {
  const agent = await store.getAgent(String(request.params.agentId));
  if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" });
  const campaign = await store.getEmailCampaign(String(request.params.campaignId), agent.id, identity.workspaceId);
  if (!campaign) return response.status(404).json({ error: "Email campaign not found" });
  if (!agent.enabledTools.includes("send_email")) return response.status(403).json({ error: "Enable the approved Send email action in Configure before starting a campaign.", code: "EMAIL_ACTION_NOT_APPROVED" });
  if (!["queued", "paused"].includes(campaign.status)) return response.status(409).json({ error: `Campaign is already ${campaign.status}.` });
  const running = await store.updateEmailCampaign(campaign.id, agent.id, identity.workspaceId, { status: "running" });
  void runCampaign(store, credits, agent, running ?? campaign).catch(async (error) => { console.error("[Gbolix email-campaign] run_failed", JSON.stringify({ campaignId: campaign.id, agentId: agent.id, workspaceId: agent.workspaceId, error: error instanceof Error ? error.message : String(error) })); await store.updateEmailCampaign(campaign.id, agent.id, identity.workspaceId, { status: "failed" }); });
  return response.json(running ?? campaign);
}));
app.get("/v1/agents/:agentId/email/replies", withIdentity(async (request, response, identity) => response.json((await store.listEmailReplyEvents(String(request.params.agentId), identity.workspaceId, 100)).map((item) => item.error ? { ...item, error: publicEmailError(item.error) } : item))));
app.post("/v1/agents/:agentId/email/replies/poll", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); try { return response.json({ processed: await pollAgentReplies(store, credits, agent) }); } catch (error) { console.error("[Gbolix email-automation] manual_poll_failed", JSON.stringify({ agentId: agent.id, workspaceId: agent.workspaceId, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined })); return response.status(502).json({ error: publicEmailError(error) }); } }));
app.post("/v1/agents/:agentId/email/replies/:replyId/approve", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); const events = await store.listEmailReplyEvents(agent.id, identity.workspaceId, 200); const event = events.find((item) => item.id === String(request.params.replyId)); if (!event) return response.status(404).json({ error: "Reply draft not found" }); try { return response.json(await approveReply(store, credits, agent, event)); } catch (error) { console.error("[Gbolix email-automation] manual_approve_failed", JSON.stringify({ agentId: agent.id, workspaceId: agent.workspaceId, eventId: event.id, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined })); return response.status(502).json({ error: publicEmailError(error) }); } }));

app.post("/v1/agents/:agentId/api-keys", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); if (agent.level < 3) return response.status(402).json({ error: "Level 3 is required to create developer API keys.", code: "LEVEL_REQUIRED", level: 3 }); const raw = `gblx_live_${crypto.randomBytes(24).toString("base64url")}`; const record = await store.createApiKey({ agentId: agent.id, workspaceId: identity.workspaceId, keyPrefix: raw.slice(0, 18), keyHash: hash(raw), status: "active" }); return response.status(201).json({ apiKey: raw, record }); }));
app.get("/v1/agents/:agentId/api-keys", withIdentity(async (request, response, identity) => response.json(await store.listApiKeys(String(request.params.agentId), identity.workspaceId))));
app.delete("/v1/agents/:agentId/api-keys/:keyId", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent || agent.workspaceId !== identity.workspaceId) return response.status(404).json({ error: "Agent not found" }); const revoked = await store.revokeApiKey(String(request.params.keyId), agent.id, identity.workspaceId); return revoked ? response.status(204).send() : response.status(404).json({ error: "API key not found" }); }));
app.get("/v1/agents/:agentId/usage", withIdentity(async (request, response, identity) => { const agentId = String(request.params.agentId); const events = await store.listUsage(agentId, identity.workspaceId, Math.min(Number(request.query.limit ?? 50), 200)); const conversations = await store.listConversations(agentId, identity.workspaceId); return response.json({ events, summary: { requests: events.length, responses: events.filter((item) => item.status === "completed").length, failed: events.filter((item) => item.status === "failed").length, toolCalls: events.reduce((sum, item) => sum + item.toolCalls, 0), creditsUsed: events.reduce((sum, item) => sum + item.credits, 0), conversations: conversations.length, resolved: conversations.filter((item) => item.status === "resolved").length, handoffs: conversations.filter((item) => item.status === "handoff").length, open: conversations.filter((item) => item.status === "open").length } }); }));
app.get("/v1/activity", withIdentity(async (request, response, identity) => { const limit = Math.min(Math.max(Number(request.query.limit ?? 100) || 100, 1), 200); const agents = await store.listAgents(identity.workspaceId); const rows: Array<{ id: string; type: string; description: string; status: string; agentId?: string; agentName?: string; createdAt: string }> = []; for (const agent of agents) { const [usage, conversations, deployments] = await Promise.all([store.listUsage(agent.id, identity.workspaceId, limit), store.listConversations(agent.id, identity.workspaceId), store.listDeployments(agent.id, identity.workspaceId)]); usage.forEach((event) => rows.push({ id: event.requestId, type: "usage", description: event.status === "completed" ? "AI response completed" : `Usage event ${event.status}`, status: event.status, agentId: agent.id, agentName: agent.name, createdAt: event.createdAt })); conversations.forEach((conversation) => rows.push({ id: conversation.id, type: "conversation", description: `Conversation ${conversation.status}`, status: conversation.status, agentId: agent.id, agentName: agent.name, createdAt: conversation.updatedAt })); deployments.forEach((deployment) => rows.push({ id: deployment.id, type: "deployment", description: `Website deployment ${deployment.status}`, status: deployment.status, agentId: agent.id, agentName: agent.name, createdAt: deployment.updatedAt })); } const audits = await store.listAudit(identity.workspaceId, limit); audits.forEach((audit) => rows.push({ id: audit.id, type: "audit", description: `${audit.action} ${audit.targetType}`, status: "recorded", agentId: audit.targetType === "agent" ? audit.targetId : undefined, createdAt: audit.createdAt })); return response.json(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)); }));

const adminLimit = (request: Request) => Math.min(Math.max(Number(request.query.limit ?? 100) || 100, 1), 200);
app.get("/v1/admin/overview", withIdentity(async (_request, response) => response.json(await store.adminOverview()), { requireAdmin: true }));
app.get("/v1/admin/customers", withIdentity(async (request, response) => { const rows = await store.adminCustomers(adminLimit(request)); const labeled = await Promise.all(rows.map(async (row) => ({ ...row, ...(await customerLabel(row.workspaceId)) }))); return response.json(labeled); }, { requireAdmin: true }));
app.get("/v1/admin/agents", withIdentity(async (request, response) => response.json(await store.adminAgents(adminLimit(request))), { requireAdmin: true }));
app.patch("/v1/admin/agents/:agentId", withIdentity(async (request, response, identity) => { const agent = await store.getAgent(String(request.params.agentId)); if (!agent) return response.status(404).json({ error: "Agent not found" }); const action = String((request.body as Record<string, unknown>)?.action ?? ""); const status = action === "freeze" ? "paused" : action === "unfreeze" || action === "enable" ? "active" : action === "disable" ? "disabled" : undefined; if (!status) return response.status(400).json({ error: "action must be freeze, unfreeze, disable, or enable" }); const updated = await store.updateAgent(agent.id, agent.workspaceId, { status }); if (!updated) return response.status(404).json({ error: "Agent not found" }); await store.addAuditEvent({ actorId: identity.subject, workspaceId: agent.workspaceId, action: `agent.${action}`, targetType: "agent", targetId: agent.id, metadata: { previousStatus: agent.status, newStatus: updated.status } }); return response.json(updated); }, { requireAdmin: true }));
app.get("/v1/admin/conversations", withIdentity(async (request, response) => response.json(await store.adminConversations(adminLimit(request))), { requireAdmin: true }));
app.get("/v1/admin/conversations/:conversationId", withIdentity(async (request, response) => { const item = await store.adminConversation(String(request.params.conversationId)); return item ? response.json(item) : response.status(404).json({ error: "Conversation not found" }); }, { requireAdmin: true }));
app.get("/v1/admin/usage", withIdentity(async (request, response) => response.json(await store.adminUsage(adminLimit(request))), { requireAdmin: true }));
app.get("/v1/admin/deployments", withIdentity(async (request, response) => response.json(await store.adminDeployments(adminLimit(request))), { requireAdmin: true }));
app.delete("/v1/admin/deployments/:deploymentId", withIdentity(async (request, response) => { const revoked = await store.adminRevokeDeployment(String(request.params.deploymentId)); return revoked ? response.status(204).send() : response.status(404).json({ error: "Deployment not found" }); }, { requireAdmin: true }));
app.get("/v1/admin/knowledge", withIdentity(async (request, response) => response.json(await store.adminKnowledge(adminLimit(request))), { requireAdmin: true }));
app.get("/v1/admin/tools", withIdentity(async (_request, response) => response.json(await store.adminTools()), { requireAdmin: true }));
app.get("/v1/admin/activity", withIdentity(async (request, response) => response.json(await store.adminActivity(adminLimit(request))), { requireAdmin: true }));
app.get("/v1/admin/settings", withIdentity(async (_request, response) => response.json({ creditMode: config.creditMode, aiProvider: config.aiProvider, storage: config.databaseUrl ? "postgres" : "memory", adminUsers: config.adminUserIds.size, corsOrigins: config.corsOrigins.length }), { requireAdmin: true }));
app.post("/v1/internal/credit-authorizations", (request, response, next) => { try { resolveInternalIdentity({ headers: request.headers }); return next(); } catch (error) { return next(error); } }, (_request, response) => response.status(501).json({ error: "The platform credit authorization endpoint is owned by Gbolix.site." }));
app.post("/v1/internal/usage-events", (request, response, next) => { try { resolveInternalIdentity({ headers: request.headers }); return next(); } catch (error) { return next(error); } }, (_request, response) => response.status(501).json({ error: "The platform usage event endpoint is owned by Gbolix.site." }));

if (config.emailPollingEnabled) {
  const runEmailPoll = () => { void pollAllConfiguredAgents(store, credits).catch((error) => console.error("[Gbolix email-automation] poll_loop_failed", error)); };
  setTimeout(runEmailPoll, 10000);
  setInterval(runEmailPoll, Math.max(60000, config.emailPollingIntervalMs));
}

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => { const rawMessage = error instanceof Error ? error.message : "Unexpected server error"; const isProviderFailure = /gemini|openai|ai provider|quota|resource_exhausted|rate limit/i.test(rawMessage); const message = isProviderFailure ? publicAIError(error) : rawMessage; const status = /authentication|origin|admin access/i.test(rawMessage) ? 401 : 500; const requestId = response.getHeader("x-request-id") ?? `http_${crypto.randomBytes(8).toString("hex")}`; console.error("[Gbolix request] unhandled_error", JSON.stringify({ requestId, method: request.method, path: request.path, status, error: rawMessage, stack: error instanceof Error ? error.stack : undefined })); response.status(status).json({ error: message, message, code: "REQUEST_FAILED", requestId }); });

async function verifyPaidLevelEntitlement(identity: Identity, requestedLevel: number): Promise<{ allowed: boolean; currentLevel: number; status?: string }> {
  if (requestedLevel <= 1) return { allowed: true, currentLevel: 1, status: "free" };
  if (config.creditMode !== "platform" || !config.platformUrl || !config.platformToken) throw new Error("Subscription entitlement service is not configured.");
  const response = await fetch(`${config.platformUrl.replace(/\/$/, "")}/api/ai-agent/subscriptions/entitlement-check`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.platformToken}` }, body: JSON.stringify({ workspaceKey: identity.workspaceKey ?? identity.workspaceId, requestedLevel }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Subscription entitlement service returned ${response.status}.`);
  const data = await response.json() as { allowed?: boolean; currentLevel?: number; status?: string };
  return { allowed: data.allowed === true, currentLevel: Number(data.currentLevel ?? 1), status: data.status };
}

function consumeMessageRateLimit(key: string) { const nowMs = Date.now(); const current = messageRateLimits.get(key); if (!current || nowMs - current.windowStart >= config.rateLimitWindowMs) { messageRateLimits.set(key, { windowStart: nowMs, count: 1 }); return { allowed: true, retryAfterMs: 0 }; } if (current.count >= config.rateLimitMaxRequests) return { allowed: false, retryAfterMs: config.rateLimitWindowMs - (nowMs - current.windowStart) }; current.count += 1; return { allowed: true, retryAfterMs: 0 }; }
function withIdentity(handler: (request: Request, response: Response, identity: Identity) => Promise<unknown>, options?: { allowPublicDeployment?: boolean; requireAdmin?: boolean }) {
  return async (request: Request, response: Response, next: NextFunction) => { try { const identity = await resolveIdentity({ headers: request.headers }, store, options); await handler(request, response, identity); } catch (error) { next(error); } };
}
function versionConfig(agent: { name: string; description: string; instructions: string; tone: string; model: string; level: Agent["level"]; status: Agent["status"]; welcomeMessage: string; enabledTools: string[] }) { return { name: agent.name, description: agent.description, instructions: agent.instructions, tone: agent.tone, model: agent.model, level: agent.level, status: agent.status, welcomeMessage: agent.welcomeMessage, enabledTools: agent.enabledTools }; }
async function customerLabel(workspaceId: string) { if (!clerkClient) return { customerName: undefined }; try { const user = await clerkClient.users.getUser(workspaceId); const customerName = [user.firstName, user.lastName].filter(Boolean).join(" ") || (user.username && user.username !== user.primaryEmailAddress?.emailAddress ? user.username : undefined); const customerEmail = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress; return { customerName, customerEmail }; } catch { return { customerName: undefined }; } }
function safeStringMap(value: unknown): Record<string, string> { if (!value || typeof value !== "object" || Array.isArray(value)) return {}; return Object.fromEntries((Object.entries(value as Record<string, unknown>).filter(([, item]) => typeof item === "string").slice(0, 20) as Array<[string, string]>).map(([key, item]) => [key.slice(0, 80), item.slice(0, 500)])); }
function sealSecret(value: string): string { if (!config.connectionEncryptionKey) throw new Error("AGENT_CONNECTION_ENCRYPTION_KEY is required before storing connection secrets."); const key = crypto.createHash("sha256").update(config.connectionEncryptionKey).digest(); const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); const tag = cipher.getAuthTag(); return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`; }
function bearerToken(request: Request) { const value = request.header("authorization"); return value?.startsWith("Bearer ") ? value.slice(7) : undefined; }
function allowCors(request: Request, response: Response, next: NextFunction, origin?: string) { if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); response.setHeader("Access-Control-Allow-Headers", "content-type,authorization,x-request-id"); response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS"); } if (request.method === "OPTIONS") return response.status(204).end(); return next(); }
async function parseAdminProviderInput(body: Record<string, unknown>, forcedId?: string, current?: { id: string; name: string; adapter: AiProviderAdapter; baseUrl: string; defaultModel: string; priority: number; enabled: boolean }): Promise<{ ok: true; value: { id: string; name: string; adapter: AiProviderAdapter; baseUrl: string; apiKey: string; defaultModel: string; priority: number; enabled: boolean } } | { ok: false; status: number; error: string }> {
  const idValue = forcedId ?? (typeof body.id === "string" ? body.id.trim().toLowerCase() : "");
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62})$/.test(idValue)) return { ok: false, status: 400, error: "id must be 1-63 characters using lowercase letters, numbers, hyphens, or underscores." };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : current?.name ?? "";
  if (!name) return { ok: false, status: 400, error: "name is required." };
  const adapter = body.adapter === "gemini" || body.adapter === "openai_compatible" ? body.adapter : current?.adapter;
  if (!adapter) return { ok: false, status: 400, error: "adapter must be gemini or openai_compatible." };
  const defaultBaseUrl = adapter === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1";
  const baseUrlValue = typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : current?.baseUrl ?? defaultBaseUrl;
  let baseUrl: URL;
  try { baseUrl = new URL(baseUrlValue); } catch { return { ok: false, status: 400, error: "baseUrl must be a valid public HTTPS URL." }; }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.toString().length > 4096 || isPrivateHostname(baseUrl.hostname)) return { ok: false, status: 400, error: "baseUrl must be a public HTTPS URL without credentials or query parameters." };
  const secret = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (secret.length > 4096) return { ok: false, status: 413, error: "The provider API key is too long." };
  if (!current && !secret) return { ok: false, status: 400, error: "apiKey is required when adding a provider." };
  const defaultModel = typeof body.defaultModel === "string" ? body.defaultModel.trim().slice(0, 160) : current?.defaultModel ?? "";
  const numericPriority = body.priority === undefined ? current?.priority ?? 100 : Number(body.priority);
  if (!Number.isInteger(numericPriority) || numericPriority < 0 || numericPriority > 100000) return { ok: false, status: 400, error: "priority must be an integer from 0 to 100000." };
  return { ok: true, value: { id: idValue, name, adapter, baseUrl: baseUrl.toString().replace(/\/$/, ""), apiKey: secret, defaultModel, priority: numericPriority, enabled: body.enabled === undefined ? current?.enabled ?? true : body.enabled !== false } };
}
async function safeKnowledgeUrl(raw: string) { try { const target = new URL(raw); if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname.length > 2048 || target.toString().length > 4096 || isPrivateHostname(target.hostname)) return undefined; const addresses = await lookup(target.hostname, { all: true }); if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) return undefined; return target; } catch { return undefined; } }
function isPrivateHostname(hostname: string) { const normalized = hostname.toLowerCase(); return normalized === "localhost" || normalized.endsWith(".local") || normalized.endsWith(".internal") || normalized === "metadata.google.internal"; }
function normalizeEnabledTools(level: number, value: unknown): string[] | undefined { if (!Array.isArray(value)) return undefined; if (level < 3) return []; return [...new Set(value.filter((item): item is string => typeof item === "string" && Object.prototype.hasOwnProperty.call(BUILTIN_TOOLS, item)))]; }
function isPrivateIp(address: string) { const normalized = address.toLowerCase(); if (normalized.includes(":")) return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:"); const parts = normalized.split(".").map(Number); if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true; return parts[0] === 10 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127 || parts[0] === 0; }
function stripHtml(value: string) { return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/[ \t\n\r]+/g, " ").trim(); }
function normalizeOrigin(value: string) { try { const url = new URL(value.trim()); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) return undefined; return url.origin; } catch { return undefined; } }
function publicBaseUrl(request: Request) { const configured = process.env.PUBLIC_BASE_URL?.replace(/\/$/, ""); if (configured) return configured; const host = request.get("host"); const forwardedProto = request.header("x-forwarded-proto")?.split(",")[0]?.trim(); const protocol = process.env.NODE_ENV === "production" || forwardedProto === "https" ? "https" : request.protocol; return `${protocol}://${host}`; }
function widgetHtml(agentId?: string, token?: string) { const script = agentId && token ? `<script src="/widget.js" data-gbolix-agent="${encodeURIComponent(agentId)}" data-gbolix-token="${encodeURIComponent(token)}" async></script>` : ""; return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gbolix AI Agent</title><style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#0b0f14;color:#fff}*{box-sizing:border-box}</style></head><body><div id="gbolix-widget-root"></div>${script}<script>window.parent.postMessage({type:'gbolix-widget-ready'},'*')</script></body></html>`; }
function widgetScript() { return `(() => { const script = document.currentScript; const agentId = script?.dataset.gbolixAgent; const token = script?.dataset.gbolixToken; if (!agentId || !token) return; const base = new URL(script.src).origin; const root = document.createElement('div'); root.id = 'gbolix-ai-agent'; root.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:Inter,system-ui,sans-serif'; document.body.appendChild(root); const shadow = root.attachShadow({mode:'open'}); shadow.innerHTML = '<style>:host{all:initial}.toggle{width:58px;height:58px;border:0;border-radius:50%;background:#00ff66;color:#07110b;font-size:25px;cursor:pointer;box-shadow:0 10px 30px #00ff6640}.panel{display:none;width:340px;height:500px;margin-bottom:12px;overflow:hidden;border:1px solid #26313b;border-radius:18px;background:#121821;color:#fff;box-shadow:0 20px 60px #0008}.panel.open{display:flex;flex-direction:column}.head{padding:17px 18px;background:linear-gradient(135deg,#0f171f,#17232c);border-bottom:1px solid #26313b}.title{font-weight:800}.sub{margin-top:4px;font-size:12px;color:#a8b5c2}.messages{flex:1;padding:14px;overflow:auto}.bubble{max-width:82%;margin:8px 0;padding:10px 12px;border-radius:14px;font-size:13px;line-height:1.45;white-space:pre-wrap}.user{margin-left:auto;background:#00ff66;color:#07110b}.assistant{background:#1d2933;color:#edf5f0}.form{display:flex;gap:8px;padding:12px;border-top:1px solid #26313b}.input{flex:1;min-width:0;border:1px solid #34424d;border-radius:10px;background:#0b0f14;color:#fff;padding:10px}.send{border:0;border-radius:10px;background:#00ff66;color:#07110b;font-weight:800;padding:0 12px;cursor:pointer}</style><div class="panel"><div class="head"><div class="title">Gbolix AI Agent</div><div class="sub">How can we help today?</div></div><div class="messages"></div><form class="form"><input class="input" aria-label="Message" placeholder="Type a message…"><button class="send">Send</button></form></div><button class="toggle" aria-label="Open AI Assistant">✦</button>'; const panel=shadow.querySelector('.panel'); const toggle=shadow.querySelector('.toggle'); const messages=shadow.querySelector('.messages'); const form=shadow.querySelector('.form'); const input=shadow.querySelector('.input'); let conversationId; let opened=false; const add=(text,kind)=>{const el=document.createElement('div');el.className='bubble '+kind;el.textContent=text;messages.appendChild(el);messages.scrollTop=messages.scrollHeight}; toggle.addEventListener('click',()=>{opened=!opened;panel.classList.toggle('open',opened);if(opened&&messages.childElementCount===0)add('Hi! How can I help you today?','assistant')}); form.addEventListener('submit',async(event)=>{event.preventDefault();const text=input.value.trim();if(!text)return;input.value='';add(text,'user');try{const r=await fetch(base+'/v1/agents/'+encodeURIComponent(agentId)+'/messages',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({message:text,conversationId,visitorKey:location.host,channel:'website'})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Unable to respond');conversationId=data.conversationId;add(data.response,'assistant')}catch(error){add(error.message||'Unable to respond right now.','assistant')}}); })();`; }

app.listen(config.port, "0.0.0.0", () => { console.log(`Gbolix AI Agent engine listening on ${config.port}`); });
