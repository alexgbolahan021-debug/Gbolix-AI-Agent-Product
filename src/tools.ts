import type { ToolDefinition } from "./provider.js";

export const BUILTIN_TOOLS: Record<string, ToolDefinition> = {
  capture_contact: {
    type: "function",
    function: {
      name: "capture_contact",
      description: "Capture a visitor's contact details when they want a follow-up from the business team.",
      parameters: { type: "object", properties: { name: { type: "string", description: "Visitor name" }, email: { type: "string", description: "Visitor email address" }, phone: { type: "string", description: "Visitor phone number" }, note: { type: "string", description: "Reason or context for the follow-up" } }, required: ["name", "email"], additionalProperties: false },
    },
  },
  create_lead: {
    type: "function",
    function: {
      name: "create_lead",
      description: "Create a structured sales lead after a visitor expresses buying or partnership intent.",
      parameters: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, company: { type: "string" }, requirements: { type: "string" } }, required: ["name", "email", "requirements"], additionalProperties: false },
    },
  },
  send_email: {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email through the customer's connected Google Gmail account. Only use this when email sending is explicitly approved and the user explicitly asks the agent to send an email. Never claim an email was sent unless the tool confirms success.",
      parameters: { type: "object", properties: { to: { type: "string", description: "Recipient email address" }, subject: { type: "string", description: "Email subject" }, body: { type: "string", description: "Plain-text email body" } }, required: ["to", "subject", "body"], additionalProperties: false },
    },
  },
  calendar_check_availability: {
    type: "function",
    function: {
      name: "calendar_check_availability",
      description: "Check whether a requested time range is free on the connected Google Calendar. Use before proposing or booking an appointment.",
      parameters: { type: "object", properties: { start: { type: "string", description: "RFC3339 start time including timezone" }, end: { type: "string", description: "RFC3339 end time including timezone" }, timeZone: { type: "string", description: "IANA timezone, for example Africa/Lagos" } }, required: ["start", "end"], additionalProperties: false },
    },
  },
  calendar_create_event: {
    type: "function",
    function: {
      name: "calendar_create_event",
      description: "Create one appointment on the connected primary Google Calendar after availability has been checked and all required details are known.",
      parameters: { type: "object", properties: { summary: { type: "string", description: "Appointment title" }, description: { type: "string", description: "Appointment details" }, location: { type: "string", description: "Appointment location or meeting link" }, start: { type: "string", description: "RFC3339 start time including timezone" }, end: { type: "string", description: "RFC3339 end time including timezone" }, timeZone: { type: "string", description: "IANA timezone" }, attendeeEmail: { type: "string", description: "Optional attendee email" }, attendeeName: { type: "string", description: "Optional attendee name" } }, required: ["summary", "start", "end"], additionalProperties: false },
    },
  },
  calendar_cancel_event: {
    type: "function",
    function: {
      name: "calendar_cancel_event",
      description: "Cancel an existing Google Calendar event only when the user explicitly requests cancellation and supplies the event ID.",
      parameters: { type: "object", properties: { eventId: { type: "string", description: "Google Calendar event ID" } }, required: ["eventId"], additionalProperties: false },
    },
  },
  calendar_modify_event: {
    type: "function",
    function: {
      name: "calendar_modify_event",
      description: "Modify an existing Google Calendar event only when the user explicitly requests a change and supplies the event ID and changed appointment details.",
      parameters: { type: "object", properties: { eventId: { type: "string", description: "Google Calendar event ID" }, summary: { type: "string", description: "Updated appointment title" }, description: { type: "string", description: "Updated appointment details" }, location: { type: "string", description: "Updated appointment location" }, start: { type: "string", description: "Updated RFC3339 start time including timezone" }, end: { type: "string", description: "Updated RFC3339 end time including timezone" }, timeZone: { type: "string", description: "IANA timezone" }, attendeeEmail: { type: "string", description: "Optional replacement attendee email" }, attendeeName: { type: "string", description: "Optional replacement attendee name" } }, required: ["eventId"], additionalProperties: false },
    },
  },
};

export async function executeTool(name: string, rawArguments: string): Promise<{ output: string; handoff: boolean }> {
  let args: Record<string, unknown>;
  try { args = JSON.parse(rawArguments) as Record<string, unknown>; } catch { return { output: "The tool input was not valid JSON, so no action was taken.", handoff: false }; }
  if (name === "capture_contact") return { output: JSON.stringify({ ok: true, action: "contact_captured", contact: { name: args.name ?? "", email: args.email ?? "", phone: args.phone ?? "", note: args.note ?? "" } }), handoff: false };
  if (name === "create_lead") return { output: JSON.stringify({ ok: true, action: "lead_created", leadId: `lead_${Date.now().toString(36)}`, lead: { name: args.name ?? "", email: args.email ?? "", company: args.company ?? "", requirements: args.requirements ?? "" } }), handoff: false };
  if (name === "send_email") return { output: "The Gmail send action requires a connected Google Gmail account and is executed by the agent runtime.", handoff: false };
  if (name.startsWith("calendar_")) return { output: "The Calendar action requires a connected Google Calendar account and is executed by the agent runtime.", handoff: false };
  return { output: `Tool ${name} is not enabled for this agent.`, handoff: false };
}
