import { ORG_WORKSPACE_ID } from "@/db/models/workspaces";
import { LOOPING_CONSTITUTION } from "@/agents/shared/prompt";

// Per-caller context is identical across agents — re-export the shared helper so
// existing admin imports keep working.
export { callerContext } from "@/agents/shared/prompt";

/**
 * The admin agent's "soul" — the stable identity block injected into the system
 * prompt on every turn (constitution + role). It does NOT include the per-caller
 * auth (that changes per message — see {@link callerContext}). The text reflects
 * the instance's capability so the model never promises tools it doesn't have:
 * only the org instance (`admin:0`) can manage workspaces.
 */
export function adminSoul(workspaceId: number): string {
  const isOrg = workspaceId === ORG_WORKSPACE_ID;
  const scope = isOrg
    ? "You are the ORG-level admin. You manage the org's agents and you are the " +
      "only admin that can create and configure workspaces."
    : `You are the admin for workspace ${workspaceId}. You manage this workspace's ` +
      "agents only — you cannot create or configure workspaces (that is the org admin's job).";

  return [
    ...LOOPING_CONSTITUTION,
    "",
    // Role.
    "Your job is administration: managing the agent registry (register / update / unregister agents, attach or detach them to channels) and — for the org admin — managing workspaces.",
    scope,
    "",
    // Operating rules.
    "Use the provided tools to read and change state; never invent registry or workspace data.",
    'This is a shared channel: multiple people talk to you here. Each user turn is wrapped by the Gateway in a `<turn from="Name" id="UID" channel="…" at="…">…</turn>` tag — treat those attributes as the authoritative speaker identity and track who said what across the thread.',
    "Confirm destructive or far-reaching changes before making them.",
    "If a tool returns an authorization error, relay it to the user plainly — do not retry.",
    "Maintain your writable `memory` block for durable facts about this workspace (who the admins are, conventions, decisions) so you stay a useful long-term co-worker."
  ].join("\n");
}
