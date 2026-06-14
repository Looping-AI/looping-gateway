import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import * as schema from "../schema";

/**
 * Grant workspace-admin to a user. Ensures a slack_users stub exists first (the
 * member may be unknown until team_join/reconcile enriches them), then inserts
 * the admin row, ignoring duplicates. Both writes run in one atomic D1 batch.
 */
export async function addWorkspaceAdmin(
  db: Db,
  workspaceId: number,
  slackUserId: string,
  source: "membership" | "bootstrap" = "membership"
): Promise<void> {
  await db.batch([
    db.insert(schema.slackUsers).values({ slackUserId }).onConflictDoNothing(),
    db
      .insert(schema.workspaceAdmins)
      .values({ workspaceId, slackUserId, source })
      .onConflictDoNothing()
  ]);
}

export async function removeWorkspaceAdmin(
  db: Db,
  workspaceId: number,
  slackUserId: string
): Promise<void> {
  await db
    .delete(schema.workspaceAdmins)
    .where(
      and(
        eq(schema.workspaceAdmins.workspaceId, workspaceId),
        eq(schema.workspaceAdmins.slackUserId, slackUserId)
      )
    );
}

export async function listWorkspaceAdminIds(
  db: Db,
  workspaceId: number
): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.workspaceAdmins.slackUserId })
    .from(schema.workspaceAdmins)
    .where(eq(schema.workspaceAdmins.workspaceId, workspaceId));
  return new Set(rows.map((r) => r.id));
}

export async function getAdminWorkspaces(
  db: Db,
  slackUserId: string
): Promise<number[]> {
  const rows = await db
    .select({ wsId: schema.workspaceAdmins.workspaceId })
    .from(schema.workspaceAdmins)
    .where(eq(schema.workspaceAdmins.slackUserId, slackUserId));
  return rows.map((r) => r.wsId);
}
