import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
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
  upsertSlackChannel,
  getSlackChannelIdByName
} from "@/db/models/channels";
import {
  iterateSlackUsers,
  iterateSlackChannels,
  fetchChannelMemberIds,
  getBotUserId,
  getBotInfo
} from "@/wrappers/slack";

export interface ReconcileResult {
  channelsUpserted: number;
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

export interface ChannelSyncResult {
  channelsUpserted: number;
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
export async function anchorTeamId(): Promise<TeamIdAnchorResult> {
  const result: TeamIdAnchorResult = {
    teamIdBootstrapped: false,
    drifted: false
  };

  const { teamId: liveTeamId } = await getBotInfo();
  if (!liveTeamId) return result;

  const pinned = await getSlackTeamId();
  if (pinned === null) {
    await setSlackTeamId(liveTeamId);
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

/** Upsert every named Slack channel into D1 from a single conversations.list pass. */
export async function syncChannels(): Promise<ChannelSyncResult> {
  let channelsUpserted = 0;
  for await (const c of iterateSlackChannels()) {
    await upsertSlackChannel({ channelId: c.id, name: c.name });
    channelsUpserted++;
  }
  return { channelsUpserted };
}

/**
 * Resolve org admin channel from the D1 channel registry (populated by
 * syncChannels in the prior step). Writes only on change.
 */
export async function resolveOrgChannel(): Promise<OrgChannelResult> {
  const org = await getWorkspace(ORG_WORKSPACE_ID);
  const channelId = await getSlackChannelIdByName(ORG_ADMIN_CHANNEL_NAME);
  if (channelId && channelId !== org?.adminChannelId) {
    await setWorkspaceAdminChannel(ORG_WORKSPACE_ID, channelId);
  }
  return { channelId: channelId ?? null };
}

/** Sync users + owner/admin flags + deactivation sweep. */
export async function syncUsers(
  orgAdminChannelId: string | null
): Promise<UserSyncResult> {
  const result: UserSyncResult = {
    usersUpserted: 0,
    usersDeactivated: 0
  };

  const orgAdminIds = orgAdminChannelId
    ? await fetchChannelMemberIds(orgAdminChannelId)
    : new Set<string>();

  const activeBefore = await listActiveSlackUserIds();
  const seen = new Set<string>();
  for await (const u of iterateSlackUsers()) {
    seen.add(u.id);
    await upsertSlackUser({
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
      await markUserDeleted(id, true);
      result.usersDeactivated++;
    }
  }

  return result;
}

/** Sync admin-channel membership diffs for all workspaces. */
export async function syncAdminMemberships(): Promise<AdminMembershipSyncResult> {
  const result: AdminMembershipSyncResult = {
    adminsAdded: 0,
    adminsRemoved: 0
  };

  const botUserId = await getBotUserId();
  for (const ws of await listWorkspaces()) {
    if (!ws.adminChannelId) continue;
    const desired = await fetchChannelMemberIds(ws.adminChannelId);
    if (botUserId) desired.delete(botUserId);
    const current = await listWorkspaceAdminIds(ws.id);

    for (const id of desired) {
      if (!current.has(id)) {
        await addWorkspaceAdmin(ws.id, id, "membership");
        result.adminsAdded++;
      }
    }
    for (const id of current) {
      if (!desired.has(id)) {
        await removeWorkspaceAdmin(ws.id, id);
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
    const result: ReconcileResult = {
      channelsUpserted: 0,
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
      const anchor = await step.do("anchor-team-id", () => anchorTeamId());
      result.teamIdBootstrapped = anchor.teamIdBootstrapped;
      if (anchor.drifted) return result;

      const channels = await step.do("sync-channels", () => syncChannels());
      result.channelsUpserted = channels.channelsUpserted;

      const org = await step.do("resolve-org-channel", () =>
        resolveOrgChannel()
      );
      const users = await step.do("sync-users", () => syncUsers(org.channelId));
      result.usersUpserted = users.usersUpserted;
      result.usersDeactivated = users.usersDeactivated;

      const admins = await step.do("sync-admin-memberships", () =>
        syncAdminMemberships()
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
