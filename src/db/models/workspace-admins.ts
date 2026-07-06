import { and, eq } from "drizzle-orm";
import { getDb } from "../client";
import * as schema from "../schema";

/**
 * Grant workspace-admin to a user. Ensures a slack_users stub exists first (the
 * member may be unknown until team_join/reconcile enriches them), then inserts
 * the admin row, ignoring duplicates. Both writes run in one atomic D1 batch.
 */
export async function addWorkspaceAdmin(
  workspaceId: number,
  slackUserId: string,
  source: "membership" | "bootstrap" = "membership"
): Promise<void> {
  const db = getDb();
  await db.batch([
    db.insert(schema.slackUsers).values({ slackUserId }).onConflictDoNothing(),
    db
      .insert(schema.workspaceAdmins)
      .values({ workspaceId, slackUserId, source })
      .onConflictDoNothing()
  ]);
}

export async function listWorkspaceAdminIds(
  workspaceId: number
): Promise<Set<string>> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.workspaceAdmins.slackUserId })
    .from(schema.workspaceAdmins)
    .where(eq(schema.workspaceAdmins.workspaceId, workspaceId));
  return new Set(rows.map((r) => r.id));
}

export async function getAdminWorkspaces(
  slackUserId: string
): Promise<number[]> {
  const db = getDb();
  const rows = await db
    .select({ wsId: schema.workspaceAdmins.workspaceId })
    .from(schema.workspaceAdmins)
    .where(eq(schema.workspaceAdmins.slackUserId, slackUserId));
  return rows.map((r) => r.wsId);
}

export async function removeWorkspaceAdmin(
  workspaceId: number,
  slackUserId: string
): Promise<void> {
  const db = getDb();
  // Only revoke membership-granted rights. Bootstrap-granted admins must be
  // removed explicitly through an admin operation, not by event/reconcile.
  await db
    .delete(schema.workspaceAdmins)
    .where(
      and(
        eq(schema.workspaceAdmins.workspaceId, workspaceId),
        eq(schema.workspaceAdmins.slackUserId, slackUserId),
        eq(schema.workspaceAdmins.source, "membership")
      )
    );
}
