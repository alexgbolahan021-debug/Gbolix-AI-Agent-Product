import crypto from "node:crypto";
import { config } from "./config.js";

export type CreditAuthorization = {
  authorizationKey: string;
  maximumCredits: number;
  mode: "local" | "platform";
};

export class CreditError extends Error {
  constructor(message: string, public readonly code: "INSUFFICIENT_CREDITS" | "PLATFORM_UNAVAILABLE") { super(message); }
}

export class CreditService {
  private localBalance = config.localCredits;
  private readonly reservations = new Map<string, number>();

  async reserve(input: { requestId: string; workspaceId: string; agentId: string; maximumCredits: number }): Promise<CreditAuthorization> {
    if (config.creditMode === "platform") {
      if (!config.platformUrl || !config.platformToken) throw new CreditError("Credit platform is not configured.", "PLATFORM_UNAVAILABLE");
      const response = await fetch(`${config.platformUrl.replace(/\/$/, "")}/api/internal/credit-authorizations`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.platformToken}` }, body: JSON.stringify({ ...input, sourceType: "gbolix_ai_agent", sourceKey: `${input.agentId}:${input.requestId}` }) });
      if (response.status === 402) throw new CreditError("This workspace does not have enough Gbolix credits.", "INSUFFICIENT_CREDITS");
      if (!response.ok) throw new CreditError(`Credit platform returned ${response.status}.`, "PLATFORM_UNAVAILABLE");
      const data = await response.json() as { authorizationKey?: string };
      if (!data.authorizationKey) throw new CreditError("Credit platform returned an invalid authorization.", "PLATFORM_UNAVAILABLE");
      return { authorizationKey: data.authorizationKey, maximumCredits: input.maximumCredits, mode: "platform" };
    }
    if (this.localBalance < input.maximumCredits) throw new CreditError("The local credit balance is empty.", "INSUFFICIENT_CREDITS");
    const authorizationKey = `local_${crypto.randomBytes(10).toString("hex")}`;
    this.reservations.set(authorizationKey, input.maximumCredits);
    return { authorizationKey, maximumCredits: input.maximumCredits, mode: "local" };
  }

  async finalize(authorization: CreditAuthorization, input: { requestId: string; workspaceId: string; agentId: string; conversationId: string; credits: number; model: string; inputTokens: number; outputTokens: number; toolCalls: number }): Promise<void> {
    if (authorization.mode === "platform") {
      const response = await fetch(`${config.platformUrl!.replace(/\/$/, "")}/api/internal/usage-events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.platformToken}` }, body: JSON.stringify({ eventType: "agent_response", authorizationKey: authorization.authorizationKey, sourceType: "gbolix_ai_agent", ...input }) });
      if (!response.ok) throw new CreditError(`Credit finalization failed with ${response.status}.`, "PLATFORM_UNAVAILABLE");
      return;
    }
    const reserved = this.reservations.get(authorization.authorizationKey) ?? 0;
    this.reservations.delete(authorization.authorizationKey);
    this.localBalance -= Math.min(reserved, input.credits);
  }

  async release(authorization: CreditAuthorization): Promise<void> {
    if (authorization.mode === "platform" && config.platformUrl && config.platformToken) {
      await fetch(`${config.platformUrl.replace(/\/$/, "")}/api/internal/credit-authorizations/${encodeURIComponent(authorization.authorizationKey)}/release`, { method: "POST", headers: { authorization: `Bearer ${config.platformToken}` } }).catch(() => undefined);
      return;
    }
    this.reservations.delete(authorization.authorizationKey);
  }

  getLocalBalance() { return this.localBalance; }
}
