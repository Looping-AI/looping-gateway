import { eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import * as schema from "../schema";

export type SlackUserRow = typeof schema.slackUsers.$inferSelect;

export interface UpsertSlackUserInput {
  slackUserId: string;
  displayName?: string | null;
  isPrimaryOwner?: boolean;
  isOrgAdmin?: boolean;
  deleted?: boolean;
}

/**
 * Insert or update a user, keyed by slack_user_id. On conflict we update ONLY
 * the fields the caller explicitly provided — a membership-derived upsert (id
 * only) never clobbers owner/admin flags learned from users.list. A null
 * display name likewise never overwrites a known one. This idempotency is what
 * keeps lifecycle events and cron reconcile safe to interleave in any order.
 */
export async function upsertSlackUser(
  db: Db,
  input: UpsertSlackUserInput
): Promise<void> {
  await db
    .insert(schema.slackUsers)
    .values({
      slackUserId: input.slackUserId,
      displayName: input.displayName ?? null,
      isPrimaryOwner: input.isPrimaryOwner ?? false,
      isOrgAdmin: input.isOrgAdmin ?? false,
      deleted: input.deleted ?? false
    })
    .onConflictDoUpdate({
      target: schema.slackUsers.slackUserId,
      set: {
        ...(input.displayName != null
          ? { displayName: input.displayName }
          : {}),
        ...(input.isPrimaryOwner !== undefined
          ? { isPrimaryOwner: input.isPrimaryOwner }
          : {}),
        ...(input.isOrgAdmin !== undefined
          ? { isOrgAdmin: input.isOrgAdmin }
          : {}),
        ...(input.deleted !== undefined ? { deleted: input.deleted } : {}),
        updatedAt: sql`(unixepoch())`
      }
    });
}

export async function getSlackUser(
  db: Db,
  slackUserId: string
): Promise<SlackUserRow | null> {
  const rows = await db
    .select()
    .from(schema.slackUsers)
    .where(eq(schema.slackUsers.slackUserId, slackUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markUserDeleted(
  db: Db,
  slackUserId: string,
  deleted: boolean
): Promise<void> {
  await db
    .update(schema.slackUsers)
    .set({ deleted, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.slackUsers.slackUserId, slackUserId));
}

/**
 * Currently-active user ids (deleted = false). Used for reconcile's
 * deactivation sweep so we mark each user deleted at most once, rather than
 * re-marking already-deactivated users on every run.
 */
export async function listActiveSlackUserIds(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.slackUsers.slackUserId })
    .from(schema.slackUsers)
    .where(eq(schema.slackUsers.deleted, false));
  return new Set(rows.map((r) => r.id));
}
