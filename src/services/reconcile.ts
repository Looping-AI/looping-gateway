import { getDb } from "@/db/client";
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
import {
  getConfig,
  setConfig,
  SystemConfigKeys
} from "@/db/models/workspace-configs";
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

/**
 * Convergence backstop: sync Slack reality → registry. Repairs any drift left
 * by missed or out-of-order lifecycle events. Every write is idempotent, so
 * running twice is a no-op. Authoritative for owner/admin flags + deactivation.
 */
export async function reconcile(env: ReconcileEnv): Promise<ReconcileResult> {
  const db = getDb(env);
  const result: ReconcileResult = {
    usersUpserted: 0,
    usersDeactivated: 0,
    adminsAdded: 0,
    adminsRemoved: 0,
    teamIdBootstrapped: false
  };

  // 0. Team-id anchor — Trust-On-First-Use (TOFU): pin on first run, then
  //    assert on every subsequent run. On mismatch we log loudly but do NOT
  //    overwrite — the anchor is intentionally write-once so a token swap
  //    (pointing to a different workspace) is caught rather than silently
  //    re-pinning, which would break all channel-id and role assumptions.
  const { teamId: liveTeamId } = await getBotInfo(env);
  if (liveTeamId) {
    const pinned = await getConfig(
      db,
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID
    );
    if (pinned === null) {
      await setConfig(
        db,
        ORG_WORKSPACE_ID,
        SystemConfigKeys.SLACK_TEAM_ID,
        liveTeamId
      );
      result.teamIdBootstrapped = true;
      console.log("[reconcile] Slack team_id anchored (first run)", {
        teamId: liveTeamId
      });
    } else if (pinned !== liveTeamId) {
      console.error(
        "[reconcile] team_id mismatch — bot token has drifted to a different workspace; NOT overwriting anchor",
        { pinned, liveTeamId }
      );
    }
  }

  // Resolve org admin channel inline (only writes on change). ws0 is assumed
  // to exist — seeded by migrations/0001_seed_builtins.sql at deploy time.
  const org = await getWorkspace(db, ORG_WORKSPACE_ID);
  const channelId = await findChannelIdByName(env, ORG_ADMIN_CHANNEL_NAME);
  if (channelId && channelId !== org?.adminChannelId) {
    await setWorkspaceAdminChannel(db, ORG_WORKSPACE_ID, channelId);
  }

  // isOrgAdmin is determined solely by membership in the looping_org_admin
  // channel — not by Slack workspace owner/admin flags.
  const orgAdminIds = channelId
    ? await fetchChannelMemberIds(env, channelId)
    : new Set<string>();

  // 1. Users — authoritative for owner/admin flags. A mid-pagination throw
  //    short-circuits before the deactivation sweep, so we never mark users
  //    deleted off partial data.
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

  // 2. Admin-channel membership — diff desired (Slack) vs current (registry).
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
