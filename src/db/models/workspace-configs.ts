import { eq, sql, and } from "drizzle-orm";
import type { Db } from "../client";
import * as schema from "../schema";
import { ORG_WORKSPACE_ID } from "./workspaces";

// ---------------------------------------------------------------------------
// Key namespaces
// ---------------------------------------------------------------------------

/**
 * Keys written only by internal system code (reconcile, bootstrap).
 * External callers should use plain strings for custom/operator keys and
 * keep them out of this namespace to avoid collisions.
 */
/**
 * Keys managed by the org admin agent at runtime (workspace 0).
 * Unlike {@link SystemConfigKeys}, these are exposed through admin tools and
 * intentionally mutable by the org admin.
 */
export const OperatorConfigKeys = {
  /**
   * JSON array of approved domain patterns for remote (custom) A2A agents.
   * Each entry covers that domain and all its subdomains. Stored on workspace 0
   * and applies org-wide. An absent or empty array means no remote agents are
   * approved (deny-all). Managed via the `remote_agent_domains` admin tool.
   */
  REMOTE_AGENT_ALLOWED_DOMAINS: "remote_agent_allowed_domains"
} as const;

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

// ---------------------------------------------------------------------------
// System config helpers (org-level, workspace 0)
// ---------------------------------------------------------------------------

export async function getSlackTeamId(db: Db): Promise<string | null> {
  return getConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID);
}

export async function setSlackTeamId(db: Db, teamId: string): Promise<void> {
  return setConfig(
    db,
    ORG_WORKSPACE_ID,
    SystemConfigKeys.SLACK_TEAM_ID,
    teamId
  );
}

export async function getPublicUrl(db: Db): Promise<string | null> {
  return getConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL);
}

export async function setPublicUrl(db: Db, url: string): Promise<void> {
  return setConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL, url);
}

// ---------------------------------------------------------------------------
// Operator config helpers (org-level, workspace 0)
// ---------------------------------------------------------------------------

/**
 * Read the org-wide list of approved remote agent domains from workspace 0.
 * Returns an empty array if not configured (which means no remote agents are
 * approved — deny-all semantics enforced in `validateRemoteEndpoint`).
 */
export async function getAllowedRemoteAgentDomains(db: Db): Promise<string[]> {
  const raw = await getConfig(
    db,
    ORG_WORKSPACE_ID,
    OperatorConfigKeys.REMOTE_AGENT_ALLOWED_DOMAINS
  );
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function setAllowedRemoteAgentDomains(
  db: Db,
  domains: string[]
): Promise<void> {
  return setConfig(
    db,
    ORG_WORKSPACE_ID,
    OperatorConfigKeys.REMOTE_AGENT_ALLOWED_DOMAINS,
    JSON.stringify(domains)
  );
}
