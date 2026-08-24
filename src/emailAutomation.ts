import crypto from "node:crypto";
import { config } from "./config.js";
import { CreditError, CreditService } from "./credits.js";
import { complete } from "./provider.js";
import { encryptGmailCredentials, getGmailAccessToken, sendGmailTestEmail, type GmailTestEmailContext } from "./testEmail.js";
import type { Agent, EmailCampaign, EmailCampaignRow, EmailReplyEvent, EmailSettings, Store, StoredAgentConnection } from "./types.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY = 100_000;
export const PUBLIC_EMAIL_ERROR = "The agent could not complete this email action. Please try again later.";
export function publicEmailError(_error: unknown): string { return PUBLIC_EMAIL_ERROR; }

type GmailHeader = { name?: string; value?: string };
type GmailMessage = { id?: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: GmailHeader[]; body?: { data?: string }; parts?: unknown[] } };

type CampaignInput = { csv: string; subjectTemplate: string; bodyTemplate: string; messageMode: "shared" | "per_row" };

export function parseCsvRecipients(csv: string, maxRows = config.emailCampaignMaxRows): Array<{ rowNumber: number; email: string; data: Record<string, string> }> {
  const records: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];
    if (char === '"') {
      if (quoted && next === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(value); value = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(value); value = "";
      if (row.some((item) => item.trim())) records.push(row);
      row = [];
    } else value += char;
  }
  if (value.length || row.length) { row.push(value); if (row.some((item) => item.trim())) records.push(row); }
  if (records.length < 2) throw new Error("The CSV must include a header row and at least one recipient.");
  const headers = records[0].map((item, index) => (item.trim() || `column_${index + 1}`).slice(0, 80));
  const emailIndex = headers.findIndex((item) => item.toLowerCase() === "email" || item.toLowerCase() === "email_address");
  if (emailIndex < 0) throw new Error("The CSV must include an `email` column.");
  const seen = new Set<string>();
  const parsed: Array<{ rowNumber: number; email: string; data: Record<string, string> }> = [];
  for (let index = 1; index < records.length; index += 1) {
    if (parsed.length >= maxRows) throw new Error(`This CSV exceeds the ${maxRows}-recipient campaign limit.`);
    const cells = records[index];
    const email = (cells[emailIndex] ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 320) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    const data: Record<string, string> = {};
    headers.forEach((header, headerIndex) => { data[header] = (cells[headerIndex] ?? "").trim().slice(0, 4000); });
    data.email = email;
    parsed.push({ rowNumber: index + 1, email, data });
  }
  if (!parsed.length) throw new Error("The CSV did not contain any valid, unique email addresses.");
  return parsed;
}

export function renderTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => data[key] ?? data[key.toLowerCase()] ?? "").trim();
}

export function validateCampaignInput(input: CampaignInput) {
  if (!input.csv.trim()) throw new Error("A CSV recipient file is required.");
  if (!input.subjectTemplate.trim() || !input.bodyTemplate.trim()) throw new Error("Subject and message templates are required.");
  if (input.subjectTemplate.length > 998 || input.bodyTemplate.length > MAX_BODY) throw new Error("The subject or message template is too long.");
  if (/[\r\n]/.test(input.subjectTemplate)) throw new Error("The subject template contains invalid header characters.");
  if (input.messageMode !== "shared" && input.messageMode !== "per_row") throw new Error("messageMode must be shared or per_row.");
}

async function gmailJson(path: string, accessToken: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${GMAIL_API}${path}`, { ...init, headers: { accept: "application/json", authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(15000) });
  } catch (error) { throw new Error(`Gmail could not be reached: ${error instanceof Error ? error.message : String(error)}`); }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : {};
    const detail = typeof error.message === "string" ? error.message : typeof data.error_description === "string" ? data.error_description : `Gmail returned HTTP ${response.status}`;
    throw new Error(`${detail} (HTTP ${response.status})`);
  }
  return data;
}

function headersOf(message: GmailMessage): Record<string, string> {
  return Object.fromEntries((message.payload?.headers ?? []).filter((header): header is { name: string; value: string } => typeof header.name === "string" && typeof header.value === "string").map((header) => [header.name.toLowerCase(), header.value]));
}

function decodeBody(data?: string): string {
  if (!data) return "";
  try { return Buffer.from(data, "base64url").toString("utf8"); } catch { return ""; }
}

function textFromParts(parts: unknown[] | undefined): string {
  if (!parts) return "";
  for (const raw of parts) {
    const part = raw as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
    if (part.mimeType === "text/plain" && part.body?.data) return decodeBody(part.body.data);
    const nested = textFromParts(part.parts);
    if (nested) return nested;
  }
  return "";
}

function bodyOf(message: GmailMessage): string {
  return decodeBody(message.payload?.body?.data) || textFromParts(message.payload?.parts).slice(0, MAX_BODY);
}

function isInbound(message: GmailMessage): boolean { return !(message.labelIds ?? []).includes("SENT"); }

async function getGmailConnection(store: Store, agent: Agent): Promise<StoredAgentConnection | undefined> {
  const connections = await store.listConnections(agent.id, agent.workspaceId);
  const gmail = connections.find((item) => item.provider === "google_gmail" && item.status === "connected");
  return gmail ? store.getConnection(gmail.id, agent.id, agent.workspaceId) : undefined;
}

function tokenContext(agent: Agent, connection: StoredAgentConnection, store: Store, requestId: string): GmailTestEmailContext {
  return { requestId, agentId: agent.id, workspaceId: agent.workspaceId, onTokenRefreshed: async (bundle) => { const encryptedSecret = encryptGmailCredentials(bundle); connection.encryptedSecret = encryptedSecret; await store.updateConnectionSecret(connection.id, agent.id, agent.workspaceId, encryptedSecret); } };
}

export async function createCampaign(store: Store, agent: Agent, input: CampaignInput): Promise<{ campaign: EmailCampaign; rows: EmailCampaignRow[] }> {
  validateCampaignInput(input);
  if (agent.level < 3) throw new Error("Level 3 is required for bulk email campaigns.");
  const recipients = parseCsvRecipients(input.csv);
  const campaign = await store.createEmailCampaign({ agentId: agent.id, workspaceId: agent.workspaceId, status: "queued", subjectTemplate: input.subjectTemplate.trim(), bodyTemplate: input.bodyTemplate.trim(), messageMode: input.messageMode, totalRows: recipients.length });
  const rows = await store.addEmailCampaignRows(recipients.map((recipient) => ({ campaignId: campaign.id, rowNumber: recipient.rowNumber, email: recipient.email, data: recipient.data, subject: renderTemplate(input.subjectTemplate, recipient.data), body: input.messageMode === "per_row" && recipient.data.custom_message ? recipient.data.custom_message : renderTemplate(input.bodyTemplate, recipient.data), status: "queued" as const })));
  return { campaign, rows };
}

export async function runCampaign(store: Store, credits: CreditService, agent: Agent, campaign: EmailCampaign): Promise<EmailCampaign> {
  const connection = await getGmailConnection(store, agent);
  if (!connection) throw new Error("Gmail is not connected for this agent. Connect Gmail before starting a campaign.");
  let current = await store.updateEmailCampaign(campaign.id, agent.id, agent.workspaceId, { status: "running" }) ?? campaign;
  const rows = await store.listEmailCampaignRows(campaign.id, 1000);
  for (const row of rows.filter((item) => item.status === "queued")) {
    const requestId = `email_${crypto.randomBytes(12).toString("hex")}`;
    let authorization;
    try { authorization = await credits.reserve({ requestId, workspaceId: agent.workspaceId, agentId: agent.id, maximumCredits: 1 }); }
    catch (error) {
      if (error instanceof CreditError && error.code === "INSUFFICIENT_CREDITS") { await store.updateEmailCampaign(campaign.id, agent.id, agent.workspaceId, { status: "paused" }); return (await store.getEmailCampaign(campaign.id, agent.id, agent.workspaceId)) ?? current; }
      throw error;
    }
    try {
      const sent = await sendGmailTestEmail(connection, { to: row.email, subject: row.subject, message: row.body }, tokenContext(agent, connection, store, requestId));
      await credits.finalize(authorization, { requestId, workspaceId: agent.workspaceId, agentId: agent.id, conversationId: `campaign_${campaign.id}`, credits: 1, model: agent.model, inputTokens: 0, outputTokens: 0, toolCalls: 1 });
      await store.updateEmailCampaignRow(row.id, campaign.id, { status: "sent", messageId: sent.id, threadId: sent.threadId });
      current = await store.updateEmailCampaign(campaign.id, agent.id, agent.workspaceId, { sentRows: current.sentRows + 1 }) ?? current;
    } catch (error) {
      await credits.release(authorization);
      console.error("[Gbolix email-campaign] recipient_failed", JSON.stringify({ campaignId: campaign.id, agentId: agent.id, workspaceId: agent.workspaceId, rowId: row.id, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }));
      await store.updateEmailCampaignRow(row.id, campaign.id, { status: "failed", error: PUBLIC_EMAIL_ERROR });
      current = await store.updateEmailCampaign(campaign.id, agent.id, agent.workspaceId, { failedRows: current.failedRows + 1 }) ?? current;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return (await store.updateEmailCampaign(campaign.id, agent.id, agent.workspaceId, { status: current.sentRows + current.failedRows >= current.totalRows ? "completed" : "paused" })) ?? current;
}

async function listInboxMessages(accessToken: string, query: string) {
  const params = new URLSearchParams({ maxResults: "50", labelIds: "INBOX", q: query ? `in:inbox -from:me (${query})` : "in:inbox -from:me" });
  const data = await gmailJson(`/messages?${params.toString()}`, accessToken);
  return Array.isArray(data.messages) ? data.messages as Array<{ id?: string; threadId?: string }> : [];
}

async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  return await gmailJson(`/messages/${encodeURIComponent(id)}?format=full`, accessToken) as GmailMessage;
}

async function getThread(accessToken: string, id: string): Promise<GmailMessage[]> {
  const data = await gmailJson(`/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID`, accessToken);
  return Array.isArray(data.messages) ? data.messages as GmailMessage[] : [];
}

function matchesQuery(message: GmailMessage, query: string): boolean {
  if (!query.trim()) return true;
  const header = headersOf(message);
  const text = `${header.from ?? ""} ${header.to ?? ""} ${header.subject ?? ""} ${bodyOf(message)}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => text.includes(term.replace(/^[-+]/, "")));
}

async function generateReply(agent: Agent, event: EmailReplyEvent) {
  const result = await complete({ model: agent.model || config.defaultModel, messages: [{ role: "system", content: `You are ${agent.name}. ${agent.instructions}\n\nWrite a concise, accurate email reply. Never invent facts. If the email needs a human decision, say that clearly. Return only the email body, without a subject or greeting metadata.` }, { role: "user", content: `Incoming email from ${event.fromEmail ?? "unknown sender"}\nSubject: ${event.subject ?? "(no subject)"}\n\n${event.body}` }], tools: [] });
  const body = result.content.trim().slice(0, MAX_BODY);
  if (!body) throw new Error("The agent generated an empty reply.");
  return { body, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

export async function pollAgentReplies(store: Store, credits: CreditService, agent: Agent): Promise<number> {
  const settings = await store.getEmailSettings(agent.id, agent.workspaceId);
  if (!settings || settings.replyMode === "off") return 0;
  const connection = await getGmailConnection(store, agent);
  if (!connection) return 0;
  const requestId = `poll_${crypto.randomBytes(8).toString("hex")}`;
  const token = await getGmailAccessToken(connection, tokenContext(agent, connection, store, requestId));
  const candidates = await listInboxMessages(token.accessToken, settings.matchingQuery);
  let processed = 0;
  for (const candidate of candidates.slice(0, 50)) {
    if (!candidate.id || !candidate.threadId) continue;
    const message = await getMessage(token.accessToken, candidate.id);
    if (!isInbound(message)) continue;
    const header = headersOf(message);
    const thread = await getThread(token.accessToken, candidate.threadId);
    const agentSent = thread.some((item) => (item.labelIds ?? []).includes("SENT"));
    const ruleMatch = matchesQuery(message, settings.matchingQuery);
    const eligible = settings.replyScope === "agent_sent" ? agentSent : settings.replyScope === "matching_rules" ? ruleMatch : agentSent || ruleMatch;
    if (!eligible) continue;
    if (await store.getEmailReplyEvent(agent.id, candidate.id)) continue;
    const event = await store.createEmailReplyEvent({ agentId: agent.id, workspaceId: agent.workspaceId, gmailMessageId: candidate.id, threadId: candidate.threadId, fromEmail: header.from, subject: header.subject, receivedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : undefined, body: bodyOf(message), status: "pending" });
    const aiRequestId = `reply_${event.id}`;
    let authorization;
    try { authorization = await credits.reserve({ requestId: aiRequestId, workspaceId: agent.workspaceId, agentId: agent.id, maximumCredits: 1 }); }
    catch (error) { console.error("[Gbolix email-automation] credit_reservation_failed", JSON.stringify({ agentId: agent.id, workspaceId: agent.workspaceId, eventId: event.id, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined })); await store.updateEmailReplyEvent(event.id, agent.id, { status: "failed", error: PUBLIC_EMAIL_ERROR }); continue; }
    try {
      const generated = await generateReply(agent, event);
      if (settings.replyMode === "draft") {
        await credits.finalize(authorization, { requestId: aiRequestId, workspaceId: agent.workspaceId, agentId: agent.id, conversationId: `reply_${event.id}`, credits: 1, model: agent.model, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, toolCalls: 0 });
        await store.updateEmailReplyEvent(event.id, agent.id, { status: "pending", replyBody: generated.body });
      } else {
        const sent = await sendGmailTestEmail(connection, { to: header.from?.match(/<([^>]+)>/)?.[1] ?? header.from ?? "", subject: `Re: ${(header.subject ?? "").replace(/^Re:\s*/i, "")}`, message: generated.body, threadId: candidate.threadId, inReplyTo: header["message-id"], references: [header.references, header["message-id"]].filter(Boolean).join(" ") }, tokenContext(agent, connection, store, aiRequestId));
        await credits.finalize(authorization, { requestId: aiRequestId, workspaceId: agent.workspaceId, agentId: agent.id, conversationId: `reply_${event.id}`, credits: 1, model: agent.model, inputTokens: generated.inputTokens, outputTokens: generated.outputTokens, toolCalls: 1 });
        await store.updateEmailReplyEvent(event.id, agent.id, { status: "sent", replyBody: generated.body, replyMessageId: sent.id });
      }
      processed += 1;
    } catch (error) {
      await credits.release(authorization);
      console.error("[Gbolix email-automation] reply_failed", JSON.stringify({ agentId: agent.id, workspaceId: agent.workspaceId, eventId: event.id, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }));
      await store.updateEmailReplyEvent(event.id, agent.id, { status: "failed", error: PUBLIC_EMAIL_ERROR });
    }
  }
  return processed;
}

export async function approveReply(store: Store, credits: CreditService, agent: Agent, event: EmailReplyEvent): Promise<EmailReplyEvent> {
  if (!event.replyBody) throw new Error("This reply has no draft body. Run inbox processing again.");
  const connection = await getGmailConnection(store, agent);
  if (!connection) throw new Error("Gmail is not connected for this agent.");
  const requestId = `reply_send_${event.id}`;
  const authorization = await credits.reserve({ requestId, workspaceId: agent.workspaceId, agentId: agent.id, maximumCredits: 1 });
  try {
    const sent = await sendGmailTestEmail(connection, { to: event.fromEmail?.match(/<([^>]+)>/)?.[1] ?? event.fromEmail ?? "", subject: `Re: ${(event.subject ?? "").replace(/^Re:\s*/i, "")}`, message: event.replyBody, threadId: event.threadId }, tokenContext(agent, connection, store, requestId));
    await credits.finalize(authorization, { requestId, workspaceId: agent.workspaceId, agentId: agent.id, conversationId: `reply_${event.id}`, credits: 1, model: agent.model, inputTokens: 0, outputTokens: 0, toolCalls: 1 });
    return await store.updateEmailReplyEvent(event.id, agent.id, { status: "sent", replyMessageId: sent.id }) ?? event;
  } catch (error) { await credits.release(authorization); console.error("[Gbolix email-automation] approved_reply_failed", JSON.stringify({ agentId: agent.id, workspaceId: agent.workspaceId, eventId: event.id, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined })); await store.updateEmailReplyEvent(event.id, agent.id, { status: "failed", error: PUBLIC_EMAIL_ERROR }); throw error; }
}

export async function pollAllConfiguredAgents(store: Store, credits: CreditService) {
  const agents = await store.listAgentsWithEmailAutomation();
  let processed = 0;
  for (const agent of agents) { try { processed += await pollAgentReplies(store, credits, agent); } catch (error) { console.error("[Gbolix email-automation] poll_failed", JSON.stringify({ agentId: agent.id, workspaceId: agent.workspaceId, error: error instanceof Error ? error.message : String(error) })); } }
  return processed;
}
