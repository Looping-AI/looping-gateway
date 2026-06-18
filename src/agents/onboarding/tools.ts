import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { UserAuthContext } from "@/auth";
import type { Db } from "@/db/client";
import {
  type AgentRow,
  listAgents,
  listChannelsForAgents
} from "@/db/models/agents";
import {
  type WorkspaceRow,
  getWorkspace,
  listWorkspaces
} from "@/db/models/workspaces";
import { getSlackUser } from "@/db/models/users";

/**
 * Onboarding concierge tools — a single consolidated, **read-only** `directory_read`
 * tool (no tool proliferation, matching the admin pattern). Operations:
 *   - `agents`     — agents the caller can reach (built-ins + their workspaces')
 *   - `workspaces` — workspaces the caller administers
 *   - `health`     — on-demand registry status for the caller
 *
 * Everything self-scopes to the caller's `UserAuthContext`. There is no
 * `authorize()` deny (the concierge serves everyone); instead, workspace-specific
 * rows are filtered to what the caller is entitled to see. The tool never writes.
 *
 * Logic is split from the AI-SDK wiring so it unit-tests without an LLM.
 */
export interface OnboardingToolDeps {
  db: Db;
  ctx: UserAuthContext | null;
}

type ToolResult = Record<string, unknown>;

/** True for the org admin / primary owner — sees every workspace. */
function seesAllWorkspaces(ctx: UserAuthContext): boolean {
  return ctx.isOrgAdmin || ctx.isPrimaryOwner;
}

function shapeAgent(a: AgentRow, channels: string[]): ToolResult {
  return {
    name: a.name,
    kind: a.kind,
    displayName: a.displayName,
    workspaceId: a.workspaceId,
    channels
  };
}

function shapeWorkspace(ws: WorkspaceRow): ToolResult {
  return {
    id: ws.id,
    name: ws.name,
    adminChannelId: ws.adminChannelId,
    adminChannelConfigured: ws.adminChannelId != null
  };
}

// ---------------------------------------------------------------------------
// Pure handlers (exported for tests).
// ---------------------------------------------------------------------------

/**
 * Every enabled agent — built-ins + custom — surfaced to any caller. Agent names
 * and the channels they live in are routing info, not secrets: a `::ref` only
 * works in a channel an admin already allowed, so showing the directory is what
 * lets the concierge route members to the right place.
 */
export async function directoryAgents(
  deps: OnboardingToolDeps
): Promise<ToolResult> {
  const enabled = (await listAgents(deps.db)).filter((a) => a.enabled);
  const channelsByAgent = await listChannelsForAgents(
    deps.db,
    enabled.map((a) => a.name)
  );
  const byAgent = new Map<string, string[]>();
  for (const { agentName, channelId } of channelsByAgent) {
    const entry = byAgent.get(agentName);
    if (entry) entry.push(channelId);
    else byAgent.set(agentName, [channelId]);
  }
  return {
    agents: enabled.map((a) => shapeAgent(a, byAgent.get(a.name) ?? []))
  };
}

/** Workspaces the caller administers (all of them for the org admin / owner). */
export async function directoryWorkspaces(
  deps: OnboardingToolDeps
): Promise<ToolResult> {
  if (!deps.ctx) return { workspaces: [] };
  if (seesAllWorkspaces(deps.ctx)) {
    return { workspaces: (await listWorkspaces(deps.db)).map(shapeWorkspace) };
  }
  const rows: ToolResult[] = [];
  for (const id of deps.ctx.adminWorkspaces) {
    const ws = await getWorkspace(deps.db, id);
    if (ws) rows.push(shapeWorkspace(ws));
  }
  return { workspaces: rows };
}

/** On-demand status for the caller, computed live from the registry. */
export async function directoryHealth(
  deps: OnboardingToolDeps
): Promise<ToolResult> {
  if (!deps.ctx) {
    return {
      registered: false,
      note: "I can't identify your Slack user yet. Try again shortly — new users are picked up by the next directory sync."
    };
  }
  const user = await getSlackUser(deps.db, deps.ctx.slackUserId);
  const registered = user != null && !user.deleted;
  const enabledAgentCount = (await listAgents(deps.db)).filter(
    (a) => a.enabled
  ).length;

  const myWorkspaces: ToolResult[] = [];
  for (const id of deps.ctx.adminWorkspaces) {
    const ws = await getWorkspace(deps.db, id);
    if (ws)
      myWorkspaces.push({
        id: ws.id,
        name: ws.name,
        adminChannelConfigured: ws.adminChannelId != null
      });
  }

  return {
    registered,
    enabledAgentCount,
    administersWorkspaces: myWorkspaces,
    note: registered
      ? undefined
      : "You're not registered yet — the next directory sync (reconcile) will pick you up; admin powers follow from your admin-channel membership."
  };
}

// ---------------------------------------------------------------------------
// AI-SDK tool wiring — thin wrapper over the handlers above.
// ---------------------------------------------------------------------------

export type DirectoryReadArgs = {
  operation: "agents" | "workspaces" | "health";
};

export async function directoryRead(
  deps: OnboardingToolDeps,
  args: DirectoryReadArgs
): Promise<ToolResult> {
  switch (args.operation) {
    case "agents":
      return directoryAgents(deps);
    case "workspaces":
      return directoryWorkspaces(deps);
    case "health":
      return directoryHealth(deps);
  }
}

/** Build the onboarding concierge's (read-only) tool set. */
export function buildOnboardingTools(deps: OnboardingToolDeps): ToolSet {
  return {
    directory_read: tool({
      description:
        "Read-only directory lookups for routing and status. " +
        "operation=agents lists agents you can reach (and the channels they're in); " +
        "operation=workspaces lists workspaces you administer (with their admin channels); " +
        "operation=health reports whether you're registered and basic system status.",
      inputSchema: z.object({
        operation: z.enum(["agents", "workspaces", "health"])
      }),
      execute: (args) => directoryRead(deps, args)
    })
  };
}
