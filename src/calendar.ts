import crypto from "node:crypto";
import { config } from "./config.js";
import type { Agent, Store, StoredAgentConnection } from "./types.js";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const PUBLIC_CALENDAR_ERROR = "The calendar action could not be completed right now. Please try again later.";

type CalendarAction = "calendar_check_availability" | "calendar_create_event" | "calendar_cancel_event" | "calendar_modify_event";
type CalendarTokenBundle = { accessToken?: string; refreshToken?: string; expiresAt?: number; scopes?: string[]; accountId?: string; accountEmail?: string };
type CalendarArgs = Record<string, unknown>;
type CalendarResult = { output: string; handoff: boolean };

function log(stage: string, fields: Record<string, unknown> = {}) { console.info("[Gbolix calendar]", JSON.stringify({ stage, ...fields })); }
function safeError(error: unknown) { return error instanceof Error ? error.message : String(error); }
function json(value: unknown) { return JSON.stringify(value); }
function fail(message = PUBLIC_CALENDAR_ERROR): CalendarResult { return { output: json({ ok: false, error: message }), handoff: false }; }
function isEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320; }
function text(args: CalendarArgs, key: string, max = 1000) { return typeof args[key] === "string" ? String(args[key]).trim().slice(0, max) : ""; }
function validDateRange(start: string, end: string) { const startMs = Date.parse(start); const endMs = Date.parse(end); return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs; }
function secretKey() { const value = config.connectionEncryptionKey ?? config.agentJwtSecret; if (!value) throw new Error("Calendar connection encryption is not configured."); return crypto.createHash("sha256").update(value).digest(); }
function openSecret(value: string): string { const [version, ivEncoded, tagEncoded, ciphertextEncoded] = value.split(":"); if (version !== "v1" || !ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error("Stored Calendar authorization is invalid."); const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivEncoded, "base64url")); decipher.setAuthTag(Buffer.from(tagEncoded, "base64url")); return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64url")), decipher.final()]).toString("utf8"); }
function seal(value: string): string { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`; }

async function refreshToken(token: CalendarTokenBundle): Promise<CalendarTokenBundle> {
  if (!token.refreshToken || !config.googleClientId || !config.googleClientSecret) throw new Error("Calendar authorization expired. Please reconnect Google Calendar.");
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: config.googleClientId, client_secret: config.googleClientSecret }).toString(), signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") throw new Error("Calendar authorization could not be refreshed. Please reconnect Google Calendar.");
  return { ...token, accessToken: data.access_token, expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined, refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : token.refreshToken };
}

async function getToken(store: Store, agent: Agent, connection: StoredAgentConnection, requestId: string): Promise<CalendarTokenBundle> {
  if (connection.provider !== "google_calendar" || connection.status !== "connected" || connection.agentId !== agent.id || connection.workspaceId !== agent.workspaceId || !connection.encryptedSecret) throw new Error("Google Calendar is not connected for this agent.");
  const token = JSON.parse(openSecret(connection.encryptedSecret)) as CalendarTokenBundle;
  if (!token.accessToken) throw new Error("Google Calendar authorization is invalid. Please reconnect Google Calendar.");
  if (token.expiresAt && token.expiresAt <= Date.now() + 60_000) {
    const refreshed = await refreshToken(token);
    await store.updateConnectionSecret(connection.id, agent.id, agent.workspaceId, seal(JSON.stringify(refreshed)));
    log("token_refreshed", { requestId, agentId: agent.id, connectionId: connection.id, hasRefreshToken: Boolean(refreshed.refreshToken) });
    return refreshed;
  }
  return token;
}

async function calendarRequest(token: CalendarTokenBundle, path: string, init: RequestInit = {}): Promise<{ response: Response; data: Record<string, unknown> }> {
  const response = await fetch(`${CALENDAR_API}${path}`, { ...init, headers: { accept: "application/json", authorization: `Bearer ${token.accessToken}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { response, data };
}

function ensureCalendarScope(token: CalendarTokenBundle, action: CalendarAction) {
  const scopes = token.scopes ?? [];
  if (action === "calendar_check_availability") {
    if (!scopes.includes(CALENDAR_SCOPE) && !scopes.includes(CALENDAR_READ_SCOPE) && !scopes.includes("https://www.googleapis.com/auth/calendar")) throw new Error("Google Calendar availability permission is missing. Please reconnect Google Calendar.");
  } else if (!scopes.includes(CALENDAR_SCOPE) && !scopes.includes("https://www.googleapis.com/auth/calendar")) throw new Error("Google Calendar event permission is missing. Please reconnect Google Calendar.");
}

async function checkAvailability(token: CalendarTokenBundle, args: CalendarArgs): Promise<{ available: boolean; busy: Array<{ start?: string; end?: string }>; start: string; end: string }> {
  const start = text(args, "start", 80); const end = text(args, "end", 80); const timeZone = text(args, "timeZone", 80);
  if (!validDateRange(start, end)) throw new Error("Please provide a valid start and end time.");
  const body = { timeMin: start, timeMax: end, ...(timeZone ? { timeZone } : {}), items: [{ id: "primary" }] };
  const { response, data } = await calendarRequest(token, "/freeBusy", { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) { log("api_rejected", { operation: "freebusy", httpStatus: response.status }); throw new Error(PUBLIC_CALENDAR_ERROR); }
  const calendar = (data.calendars as Record<string, any> | undefined)?.primary;
  const busy = Array.isArray(calendar?.busy) ? calendar.busy.filter((item: any) => item && typeof item === "object").map((item: any) => ({ start: typeof item.start === "string" ? item.start : undefined, end: typeof item.end === "string" ? item.end : undefined })) : [];
  return { available: busy.length === 0, busy, start, end };
}

function eventResource(args: CalendarArgs, partial = false) {
  const summary = text(args, "summary", 200); const description = text(args, "description", 5000); const location = text(args, "location", 1000); const start = text(args, "start", 80); const end = text(args, "end", 80); const timeZone = text(args, "timeZone", 80); const attendeeEmail = text(args, "attendeeEmail", 320); const attendeeName = text(args, "attendeeName", 200);
  if (!partial && !summary) throw new Error("An appointment title is required.");
  if ((start || end) && !validDateRange(start, end)) throw new Error("Please provide a valid start and end time.");
  if (attendeeEmail && !isEmail(attendeeEmail)) throw new Error("Please provide a valid attendee email.");
  const resource: Record<string, unknown> = {};
  if (summary) resource.summary = summary;
  if (description) resource.description = description;
  if (location) resource.location = location;
  if (start) resource.start = { dateTime: start, ...(timeZone ? { timeZone } : {}) };
  if (end) resource.end = { dateTime: end, ...(timeZone ? { timeZone } : {}) };
  if (attendeeEmail) resource.attendees = [{ email: attendeeEmail, ...(attendeeName ? { displayName: attendeeName } : {}) }];
  return resource;
}

async function createEvent(store: Store, agent: Agent, connection: StoredAgentConnection, token: CalendarTokenBundle, args: CalendarArgs, requestId: string): Promise<CalendarResult> {
  const resource = eventResource(args);
  const duplicateQuery = `/calendars/primary/events?maxResults=1&privateExtendedProperty=${encodeURIComponent(`gbolixRequestId=${requestId}`)}`;
  const duplicate = await calendarRequest(token, duplicateQuery);
  if (duplicate.response.ok && Array.isArray(duplicate.data.items) && duplicate.data.items.length) return { output: json({ ok: true, action: "calendar_event_already_created", eventId: (duplicate.data.items[0] as any).id, message: "This appointment was already created for this request." }), handoff: false };
  const availability = await checkAvailability(token, args);
  if (!availability.available) return { output: json({ ok: false, action: "calendar_time_unavailable", available: false, busy: availability.busy, message: "That time is not available. Ask the customer for another time." }), handoff: false };
  const body = { ...resource, extendedProperties: { private: { gbolixRequestId: requestId } } };
  const { response, data } = await calendarRequest(token, "/calendars/primary/events?sendUpdates=all", { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) { log("api_rejected", { operation: "create_event", httpStatus: response.status, agentId: agent.id, connectionId: connection.id }); return fail(); }
  return { output: json({ ok: true, action: "calendar_event_created", eventId: typeof data.id === "string" ? data.id : undefined, htmlLink: typeof data.htmlLink === "string" ? data.htmlLink : undefined, summary: resource.summary, start: (resource.start as any)?.dateTime, end: (resource.end as any)?.dateTime }), handoff: false };
}

export async function executeGoogleCalendarAction(store: Store, agent: Agent, connection: StoredAgentConnection, action: CalendarAction, rawArguments: string, requestId: string): Promise<CalendarResult> {
  let args: CalendarArgs;
  try { args = JSON.parse(rawArguments) as CalendarArgs; } catch { return fail("The Calendar request was invalid, so no action was taken."); }
  try {
    const token = await getToken(store, agent, connection, requestId);
    ensureCalendarScope(token, action);
    if (action === "calendar_check_availability") {
      const result = await checkAvailability(token, args);
      return { output: json({ ok: true, action, available: result.available, busy: result.busy, start: result.start, end: result.end }), handoff: false };
    }
    if (action === "calendar_create_event") return createEvent(store, agent, connection, token, args, requestId);
    const eventId = text(args, "eventId", 1024);
    if (!eventId || !/^[a-zA-Z0-9_\-]+$/.test(eventId)) return fail("A valid Calendar event ID is required.");
    if (action === "calendar_cancel_event") {
      const { response } = await calendarRequest(token, `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" });
      if (!response.ok && response.status !== 410) { log("api_rejected", { operation: "cancel_event", httpStatus: response.status, agentId: agent.id }); return fail(); }
      return { output: json({ ok: true, action: "calendar_event_cancelled", eventId }), handoff: false };
    }
    const resource = eventResource(args, true);
    if (!Object.keys(resource).length) return fail("Provide at least one appointment field to modify.");
    const { response, data } = await calendarRequest(token, `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "PATCH", body: JSON.stringify(resource) });
    if (!response.ok) { log("api_rejected", { operation: "modify_event", httpStatus: response.status, agentId: agent.id }); return fail(); }
    return { output: json({ ok: true, action: "calendar_event_modified", eventId: typeof data.id === "string" ? data.id : eventId, summary: typeof data.summary === "string" ? data.summary : undefined, start: (data.start as any)?.dateTime, end: (data.end as any)?.dateTime }), handoff: false };
  } catch (error) {
    log("action_failed", { action, agentId: agent.id, workspaceId: agent.workspaceId, error: safeError(error) });
    return fail();
  }
}

export type { CalendarAction };
