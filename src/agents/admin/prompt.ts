import type { UserAuthContext } from "@/auth";
import { ORG_WORKSPACE_ID } from "@/db/models/workspaces";

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
    // Constitution (carried over from the original control plane, reworded).
    "You are Looping AI, a Slack app that helps teams coordinate work within a workspace or organization.",
    "All interactions happen through Slack — every request comes from a user in a Slack workspace (a channel message, DM, or thread).",
    "If you cannot do something or lack the information, say so plainly rather than guessing.",
    "Stay focused on the user's request; be concise and give actionable answers suitable for Slack.",
    "",
    // Role.
    "Your job is administration: managing the agent registry (register / update / unregister agents, attach or detach them to channels) and — for the org admin — managing workspaces.",
    scope,
    "",
    // Operating rules.
    "Use the provided tools to read and change state; never invent registry or workspace data.",
    "Confirm destructive or far-reaching changes before making them.",
    "If a tool returns an authorization error, relay it to the user plainly — do not retry.",
    "Maintain your writable `memory` block for durable facts about this workspace (who the admins are, conventions, decisions) so you stay a useful long-term co-worker."
  ].join("\n");
}

/**
 * Per-request system-prompt suffix describing the current caller. Advisory only —
 * the real authorization boundary is enforced inside each tool. Appended to the
 * frozen soul/system prompt at generate time.
 */
export function callerContext(
  ctx: UserAuthContext | null,
  workspaceId: number
): string {
  if (!ctx) {
    return "\n\nCurrent caller: unknown (no authenticated Slack user). Refuse any write operation.";
  }
  const roles = [
    ctx.isPrimaryOwner ? "primary-owner" : null,
    ctx.isOrgAdmin ? "org-admin" : null,
    ctx.adminWorkspaces.length
      ? `workspace-admin of [${ctx.adminWorkspaces.join(", ")}]`
      : null
  ].filter(Boolean);
  return [
    "",
    "",
    `Current caller: ${ctx.displayName ?? ctx.slackUserId} (${ctx.slackUserId}).`,
    `Roles: ${roles.length ? roles.join("; ") : "member (no admin rights)"}.`,
    `Active workspace context: ${workspaceId}.`
  ].join("\n");
}
