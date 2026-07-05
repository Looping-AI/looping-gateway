import { eq, sql } from "drizzle-orm";
import { getDb } from "../client";
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
  input: UpsertSlackChannelInput
): Promise<void> {
  const db = getDb();
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
  channelId: string
): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ name: schema.slackChannels.name })
    .from(schema.slackChannels)
    .where(eq(schema.slackChannels.channelId, channelId))
    .limit(1);
  return rows[0]?.name ?? null;
}

/** Resolve a channel id by exact name (uses idx_slack_channels_name). null if none. */
export async function getSlackChannelIdByName(
  name: string
): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ channelId: schema.slackChannels.channelId })
    .from(schema.slackChannels)
    .where(eq(schema.slackChannels.name, name))
    .limit(1);
  return rows[0]?.channelId ?? null;
}
