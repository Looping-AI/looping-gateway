import { authorize, type UserAuthContext } from "@/auth";
// Type-only, so the tools ⇄ approvals pairing stays a compile-time one.
import type { EndpointVerifier } from "./tools";
import { getAgent, unregisterAgent, updateAgent } from "@/db/models/agents";

/**
 * A destructive admin action deferred behind a human approval. Raised by a
 * gated tool (which stores it keyed by the HITL `requestId`) and carried out by
 * {@link runGatedAction} on the resumed turn once the human clicks Approve.
 *
 * A discriminated union so new gated actions (e.g. revoke a remote-agent domain,
 * delete a workspace) drop in as extra members without touching call sites.
 */
export type GatedAction =
  | {
      kind: "unregister_agent";
      /** The custom agent to delete. */
      name: string;
      /** The workspace whose admin must authorize the deletion. */
      wsId: number;
    }
  | {
      kind: "repin_agent";
      /** The custom agent whose pinned signing identity is being replaced. */
      name: string;
      /** The workspace whose admin must authorize the re-pin. */
      wsId: number;
      /**
       * The signing identity the human was *shown* in the prompt. Re-checked
       * against the live card at approval time: what gets written must be what
       * was approved, and a key that moved again in between is a different
       * decision than the one on the screen.
       */
      jku: string;
      kid: string;
    };

/** A short, human-readable description of a pending action (for prompts/notes). */
export function describeGatedAction(action: GatedAction): string {
  switch (action.kind) {
    case "unregister_agent":
      return `delete agent "${action.name}"`;
    case "repin_agent":
      return `re-pin agent "${action.name}" to a new signing key`;
  }
}

export interface GatedActionResult {
  ok: boolean;
  /** Past-tense outcome (`ok`) or the reason it didn't happen (`!ok`). */
  summary: string;
}

/** Side-effect seams an approved action may need. Injected so this stays testable. */
export interface GatedActionDeps {
  /**
   * Re-verifies a remote agent's card and returns the signing identity it names.
   * Required by `repin_agent`, which must read the *live* card at approval time
   * rather than trust the one read when the prompt was raised.
   */
  verifyEndpoint: EndpointVerifier;
}

/**
 * Execute an approved {@link GatedAction}, re-authorizing the approver first.
 * Anyone in the thread can click Approve, so the answerer's own permissions are
 * re-checked here — an approval by a non-admin does not carry the action through.
 * Returns a short summary for the confirmation the model relays to the user.
 */
export async function runGatedAction(
  action: GatedAction,
  approver: UserAuthContext,
  deps: GatedActionDeps
): Promise<GatedActionResult> {
  switch (action.kind) {
    case "unregister_agent": {
      if (
        !authorize(approver, {
          type: "IsWorkspaceAdmin",
          workspaceId: action.wsId
        })
      ) {
        return {
          ok: false,
          summary: `you aren't authorized to delete agent "${action.name}"`
        };
      }
      const agent = await getAgent(action.name);
      if (
        !agent ||
        agent.workspaceId !== action.wsId ||
        agent.kind !== "remote"
      ) {
        return {
          ok: false,
          summary: `agent "${action.name}" can no longer be deleted (it may already be gone)`
        };
      }
      await unregisterAgent(action.name);
      return {
        ok: true,
        summary: `deleted agent "${action.name}" and its channel mappings`
      };
    }
    case "repin_agent": {
      if (
        !authorize(approver, {
          type: "IsWorkspaceAdmin",
          workspaceId: action.wsId
        })
      ) {
        return {
          ok: false,
          summary: `you aren't authorized to re-pin agent "${action.name}"`
        };
      }
      const agent = await getAgent(action.name);
      if (
        !agent ||
        agent.workspaceId !== action.wsId ||
        agent.kind !== "remote"
      ) {
        return {
          ok: false,
          summary: `agent "${action.name}" can no longer be re-pinned (it may have been removed)`
        };
      }
      // Read the card again rather than trusting the read that raised the prompt.
      // An approval can sit in Slack for a long time, and the only key worth
      // writing is one that is still live *and* still the one the human saw.
      let verified;
      try {
        verified = await deps.verifyEndpoint(agent.a2aEndpoint, agent.tenantId);
      } catch (err) {
        return {
          ok: false,
          summary: `could not re-read the card for "${action.name}": ${(err as Error).message}`
        };
      }
      if (
        verified.pin.cardSigningJku !== action.jku ||
        verified.pin.cardSigningKid !== action.kid
      ) {
        return {
          ok: false,
          summary:
            `the signing key for "${action.name}" changed again since the ` +
            `approval was raised, so nothing was re-pinned — ask again to review ` +
            `the current key`
        };
      }
      await updateAgent(action.name, {
        cardSigningJku: verified.pin.cardSigningJku,
        cardSigningKid: verified.pin.cardSigningKid
      });
      return {
        ok: true,
        summary: `re-pinned agent "${action.name}" to signing key "${action.kid}"`
      };
    }
  }
}
