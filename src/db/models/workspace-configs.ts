import { eq, sql, and } from "drizzle-orm";
import type { Db } from "../client";
import * as schema from "../schema";

// ---------------------------------------------------------------------------
// Key namespaces
// ---------------------------------------------------------------------------

/**
 * Keys written only by internal system code (reconcile, bootstrap).
 * External callers should use plain strings for custom/operator keys and
 * keep them out of this namespace to avoid collisions.
 */
export const SystemConfigKeys = {
  /**
   * The Slack `team_id` this worker is anchored to. Written once by the first
   * successful reconcile (Trust-On-First-Use); never overwritten by reconcile
   * thereafter. Compared against every incoming `/slack/events` `team_id`.
   */
  SLACK_TEAM_ID: "slack_team_id",
  /**
   * The public origin (scheme + host) of this deployed worker. Auto-discovered
   * on the first inbound `/slack/events` request and cached in the module scope
   * for the isolate's lifetime. Written to D1 once per isolate cold-start so the
   * Message Workflow (which has no `Request` in scope) can read it for JWT signing.
   * Updates automatically when Cloudflare recycles isolates after a domain change.
   */
  PUBLIC_URL: "public_url"
} as const;

export type SystemConfigKey =
  (typeof SystemConfigKeys)[keyof typeof SystemConfigKeys];

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Read a config value for a workspace+key pair.
 * Returns `null` when the row does not exist (absence = unset).
 */
export async function getConfig(
  db: Db,
  workspaceId: number,
  key: string
): Promise<string | null> {
  const rows = await db
    .select({ value: schema.workspaceConfigs.value })
    .from(schema.workspaceConfigs)
    .where(
      and(
        eq(schema.workspaceConfigs.workspaceId, workspaceId),
        eq(schema.workspaceConfigs.key, key)
      )
    )
    .limit(1);
  return rows[0]?.value ?? null;
}

/**
 * Upsert a config value for a workspace+key pair.
 * Calling this on a system key from outside internal code is intentional only
 * for deliberate operator overrides (e.g. resetting the team anchor after an
 * intentional workspace migration).
 */
export async function setConfig(
  db: Db,
  workspaceId: number,
  key: string,
  value: string
): Promise<void> {
  await db
    .insert(schema.workspaceConfigs)
    .values({ workspaceId, key, value })
    .onConflictDoUpdate({
      target: [
        schema.workspaceConfigs.workspaceId,
        schema.workspaceConfigs.key
      ],
      set: { value, updatedAt: sql`(unixepoch())` }
    });
}

/**
 * Remove a config entry entirely (absence = unset).
 * No-op if the row does not exist.
 */
export async function unsetConfig(
  db: Db,
  workspaceId: number,
  key: string
): Promise<void> {
  await db
    .delete(schema.workspaceConfigs)
    .where(
      and(
        eq(schema.workspaceConfigs.workspaceId, workspaceId),
        eq(schema.workspaceConfigs.key, key)
      )
    );
}
