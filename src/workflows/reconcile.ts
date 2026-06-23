import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getDb, type Db } from "@/db/client";
import { ORG_ADMIN_CHANNEL_NAME } from "@/config";
import {
  upsertSlackUser,
  markUserDeleted,
  listActiveSlackUserIds
} from "@/db/models/users";
import {
  getWorkspace,
  listWorkspaces,
  setWorkspaceAdminChannel,
  ORG_WORKSPACE_ID
} from "@/db/models/workspaces";
import {
  addWorkspaceAdmin,
  removeWorkspaceAdmin,
  listWorkspaceAdminIds
} from "@/db/models/workspace-admins";
import { getSlackTeamId, setSlackTeamId } from "@/db/models/workspace-configs";
import {
  iterateSlackUsers,
  fetchChannelMemberIds,
  findChannelIdByName,
  getBotUserId,
  getBotInfo
} from "@/wrappers/slack";

type ReconcileEnv = Pick<Env, "DB" | "SLACK_BOT_TOKEN">;

export interface ReconcileResult {
  usersUpserted: number;
  usersDeactivated: number;
  adminsAdded: number;
  adminsRemoved: number;
  /** True only when the Slack team_id anchor was pinned for the first time. */
  teamIdBootstrapped: boolean;
}

export interface TeamIdAnchorResult {
  teamIdBootstrapped: boolean;
  drifted: boolean;
}

export interface OrgChannelResult {
  channelId: string | null;
}

export interface UserSyncResult {
  usersUpserted: number;
  usersDeactivated: number;
}

export interface AdminMembershipSyncResult {
  adminsAdded: number;
  adminsRemoved: number;
}

type ReconcileWorkflowPayload = Record<string, never>;

/**
 * Team-id anchor — Trust-On-First-Use (TOFU). On mismatch, log loudly and
 * abort reconcile without throwing so Workflow retries are not wasted.
 */
export async function anchorTeamId(
  env: ReconcileEnv,
  db: Db
): Promise<TeamIdAnchorResult> {
  const result: TeamIdAnchorResult = {
    teamIdBootstrapped: false,
    drifted: false
  };

  const { teamId: liveTeamId } = await getBotInfo(env);
  if (!liveTeamId) return result;

  const pinned = await getSlackTeamId(db);
  if (pinned === null) {
    await setSlackTeamId(db, liveTeamId);
    result.teamIdBootstrapped = true;
    console.log("[reconcile] Slack team_id anchored (first run)", {
      teamId: liveTeamId
    });
    return result;
  }

  if (pinned !== liveTeamId) {
    result.drifted = true;
    console.error(
      `[reconcile] FATAL: bot token has drifted to a different Slack workspace. ` +
        `This worker's state is permanently bound to team_id=${pinned}. ` +
        `All channel IDs, user IDs, and auth assumptions belong to that workspace. ` +
        `Continuing would silently corrupt the registry. ` +
        `Deploy a brand-new Worker for the new workspace — see README for migration guidance.`,
      { pinned, liveTeamId }
    );
  }

  return result;
}

/** Resolve org admin channel (writes only on change). */
export async function resolveOrgChannel(
  env: ReconcileEnv,
  db: Db
): Promise<OrgChannelResult> {
  const org = await getWorkspace(db, ORG_WORKSPACE_ID);
  const channelId = await findChannelIdByName(env, ORG_ADMIN_CHANNEL_NAME);
  if (channelId && channelId !== org?.adminChannelId) {
    await setWorkspaceAdminChannel(db, ORG_WORKSPACE_ID, channelId);
  }
  return { channelId: channelId ?? null };
}

/** Sync users + owner/admin flags + deactivation sweep. */
export async function syncUsers(
  env: ReconcileEnv,
  db: Db,
  orgAdminChannelId: string | null
): Promise<UserSyncResult> {
  const result: UserSyncResult = {
    usersUpserted: 0,
    usersDeactivated: 0
  };

  const orgAdminIds = orgAdminChannelId
    ? await fetchChannelMemberIds(env, orgAdminChannelId)
    : new Set<string>();

  const activeBefore = await listActiveSlackUserIds(db);
  const seen = new Set<string>();
  for await (const u of iterateSlackUsers(env)) {
    seen.add(u.id);
    await upsertSlackUser(db, {
      slackUserId: u.id,
      displayName: u.displayName,
      isPrimaryOwner: u.isPrimaryOwner,
      isOrgAdmin: orgAdminIds.has(u.id),
      deleted: u.deleted
    });
    result.usersUpserted++;
  }

  for (const id of activeBefore) {
    if (!seen.has(id)) {
      await markUserDeleted(db, id, true);
      result.usersDeactivated++;
    }
  }

  return result;
}

/** Sync admin-channel membership diffs for all workspaces. */
export async function syncAdminMemberships(
  env: ReconcileEnv,
  db: Db
): Promise<AdminMembershipSyncResult> {
  const result: AdminMembershipSyncResult = {
    adminsAdded: 0,
    adminsRemoved: 0
  };

  const botUserId = await getBotUserId(env);
  for (const ws of await listWorkspaces(db)) {
    if (!ws.adminChannelId) continue;
    const desired = await fetchChannelMemberIds(env, ws.adminChannelId);
    if (botUserId) desired.delete(botUserId);
    const current = await listWorkspaceAdminIds(db, ws.id);

    for (const id of desired) {
      if (!current.has(id)) {
        await addWorkspaceAdmin(db, ws.id, id, "membership");
        result.adminsAdded++;
      }
    }
    for (const id of current) {
      if (!desired.has(id)) {
        await removeWorkspaceAdmin(db, ws.id, id);
        result.adminsRemoved++;
      }
    }
  }

  return result;
}

/** Durable, retriable reconcile runner with granular retry boundaries. */
export class ReconcileWorkflow extends WorkflowEntrypoint<
  Env,
  ReconcileWorkflowPayload
> {
  async run(
    event: WorkflowEvent<ReconcileWorkflowPayload>,
    step: WorkflowStep
  ) {
    const db = getDb(this.env);
    const result: ReconcileResult = {
      usersUpserted: 0,
      usersDeactivated: 0,
      adminsAdded: 0,
      adminsRemoved: 0,
      teamIdBootstrapped: false
    };

    // Wrap the whole run so a failing step surfaces with detail. Without this,
    // a step whose retries are exhausted bubbles up as Cloudflare's opaque
    // "workflow" exception log (just the workflow name, no cause). Slack API
    // calls inside the steps throw on transient errors (rate limits, timeouts)
    // and on missing scopes — those are the usual culprits and are otherwise
    // invisible. We log the real cause, then rethrow to preserve retry/backoff.
    try {
      const anchor = await step.do("anchor-team-id", () =>
        anchorTeamId(this.env, db)
      );
      result.teamIdBootstrapped = anchor.teamIdBootstrapped;
      if (anchor.drifted) return result;

      const org = await step.do("resolve-org-channel", () =>
        resolveOrgChannel(this.env, db)
      );
      const users = await step.do("sync-users", () =>
        syncUsers(this.env, db, org.channelId)
      );
      result.usersUpserted = users.usersUpserted;
      result.usersDeactivated = users.usersDeactivated;

      const admins = await step.do("sync-admin-memberships", () =>
        syncAdminMemberships(this.env, db)
      );
      result.adminsAdded = admins.adminsAdded;
      result.adminsRemoved = admins.adminsRemoved;

      return result;
    } catch (err) {
      console.error("[reconcile] workflow run failed", {
        instanceId: event.instanceId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }
}
