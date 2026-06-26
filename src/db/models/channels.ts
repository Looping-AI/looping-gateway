import { eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import * as schema from "../schema";

export type SlackChannelRow = typeof schema.slackChannels.$inferSelect;

export interface UpsertSlackChannelInput {
  channelId: string;
  name: string;
}

/**
 * Insert or update a channel, keyed by slack channel id. On conflict we refresh
 * the name (catches renames) and the timestamp. Idempotent so reconcile can run
 * it for every channel on every pass without churn.
 */
export async function upsertSlackChannel(
  db: Db,
  input: UpsertSlackChannelInput
): Promise<void> {
  await db
    .insert(schema.slackChannels)
    .values({
      channelId: input.channelId,
      name: input.name
    })
    .onConflictDoUpdate({
      target: schema.slackChannels.channelId,
      set: {
        name: input.name,
        updatedAt: sql`(unixepoch())`
      }
    });
}

/** The human channel name (`general`, no `#`) for a channel id, or null. */
export async function getSlackChannelName(
  db: Db,
  channelId: string
): Promise<string | null> {
  const rows = await db
    .select({ name: schema.slackChannels.name })
    .from(schema.slackChannels)
    .where(eq(schema.slackChannels.channelId, channelId))
    .limit(1);
  return rows[0]?.name ?? null;
}

/** Resolve a channel id by exact name (uses idx_slack_channels_name). null if none. */
export async function getSlackChannelIdByName(
  db: Db,
  name: string
): Promise<string | null> {
  const rows = await db
    .select({ channelId: schema.slackChannels.channelId })
    .from(schema.slackChannels)
    .where(eq(schema.slackChannels.name, name))
    .limit(1);
  return rows[0]?.channelId ?? null;
}
