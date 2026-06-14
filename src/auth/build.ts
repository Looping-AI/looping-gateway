import type { Db } from "@/db/client";
import { getSlackUser } from "@/db/models/users";
import { getAdminWorkspaces } from "@/db/models/workspace-admins";
import type { UserAuthContext } from "./authorize";

/**
 * Build a user's auth context purely from the D1 registry (slack_users flags +
 * workspace_admins membership) — no Slack call on the hot path. An unknown user
 * yields a zero-permission context. This is the only I/O in this module.
 */
export async function buildUserAuthContext(
  db: Db,
  slackUserId: string
): Promise<UserAuthContext> {
  const [user, adminWorkspaces] = await Promise.all([
    getSlackUser(db, slackUserId),
    getAdminWorkspaces(db, slackUserId)
  ]);
  return {
    slackUserId,
    displayName: user?.displayName ?? null,
    isPrimaryOwner: user?.isPrimaryOwner ?? false,
    isOrgAdmin: user?.isOrgAdmin ?? false,
    adminWorkspaces
  };
}
