import type { ToolDefinition } from "./provider.js";

export const BUILTIN_TOOLS: Record<string, ToolDefinition> = {
  capture_contact: {
    type: "function",
    function: {
      name: "capture_contact",
      description: "Capture a visitor's contact details when they want a follow-up from the business team.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Visitor name" },
          email: { type: "string", description: "Visitor email address" },
          phone: { type: "string", description: "Visitor phone number" },
          note: { type: "string", description: "Reason or context for the follow-up" },
        },
        required: ["name", "email"],
        additionalProperties: false,
      },
    },
  },
  create_lead: {
    type: "function",
    function: {
      name: "create_lead",
      description: "Create a structured sales lead after a visitor expresses buying or partnership intent.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          company: { type: "string" },
          requirements: { type: "string" },
        },
        required: ["name", "email", "requirements"],
        additionalProperties: false,
      },
    },
  },
};

export async function executeTool(name: string, rawArguments: string): Promise<{ output: string; handoff: boolean }> {
  let args: Record<string, unknown>;
  try { args = JSON.parse(rawArguments) as Record<string, unknown>; } catch { return { output: "The tool input was not valid JSON, so no action was taken.", handoff: false }; }
  if (name === "capture_contact") {
    return { output: JSON.stringify({ ok: true, action: "contact_captured", contact: { name: args.name ?? "", email: args.email ?? "", phone: args.phone ?? "", note: args.note ?? "" } }), handoff: false };
  }
  if (name === "create_lead") {
    return { output: JSON.stringify({ ok: true, action: "lead_created", leadId: `lead_${Date.now().toString(36)}`, lead: { name: args.name ?? "", email: args.email ?? "", company: args.company ?? "", requirements: args.requirements ?? "" } }), handoff: false };
  }
  return { output: `Tool ${name} is not enabled for this agent.`, handoff: false };
}
