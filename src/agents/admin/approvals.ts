import { authorize, type UserAuthContext } from "@/auth";
import { getAgent, unregisterAgent } from "@/db/models/agents";

/**
 * A destructive admin action deferred behind a human approval. Raised by a
 * gated tool (which stores it keyed by the HITL `requestId`) and carried out by
 * {@link runGatedAction} on the resumed turn once the human clicks Approve.
 *
 * A discriminated union so new gated actions (e.g. revoke a remote-agent domain,
 * delete a workspace) drop in as extra members without touching call sites.
 */
export type GatedAction = {
  kind: "unregister_agent";
  /** The custom agent to delete. */
  name: string;
  /** The workspace whose admin must authorize the deletion. */
  wsId: number;
};

/** A short, human-readable description of a pending action (for prompts/notes). */
export function describeGatedAction(action: GatedAction): string {
  switch (action.kind) {
    case "unregister_agent":
      return `delete agent "${action.name}"`;
  }
}

export interface GatedActionResult {
  ok: boolean;
  /** Past-tense outcome (`ok`) or the reason it didn't happen (`!ok`). */
  summary: string;
}

/**
 * Execute an approved {@link GatedAction}, re-authorizing the approver first.
 * Anyone in the thread can click Approve, so the answerer's own permissions are
 * re-checked here — an approval by a non-admin does not carry the action through.
 * Returns a short summary for the confirmation the model relays to the user.
 */
export async function runGatedAction(
  action: GatedAction,
  approver: UserAuthContext
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
        agent.kind !== "custom"
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
  }
}
