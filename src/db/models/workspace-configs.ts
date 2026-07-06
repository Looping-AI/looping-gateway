import { eq, sql, and } from "drizzle-orm";
import { getDb } from "../client";
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
  REMOTE_AGENT_ALLOWED_DOMAINS: "remote_agent_allowed_domains",
  /**
   * Public URL of this workspace's admin-agent avatar, generated via Workers AI
   * and served from the per-workspace admin DO (`/icons/{wsId}/admin/{key}`).
   * Stored per workspace so each admin instance has its own avatar; read by the
   * router to override the shared `admin` registry row's iconUrl. Managed via the
   * `self_write` admin tool (`set_avatar`).
   */
  ADMIN_ICON_URL: "admin_icon_url",
  /**
   * Display name of this workspace's admin agent, set by the admin itself via the
   * `self_write` tool. Stored per workspace (the `admin` registry row is shared
   * across workspaces) and read by the router to override the row's displayName.
   */
  ADMIN_DISPLAY_NAME: "admin_display_name"
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
 * Upsert a config value for a workspace+key pair.
 * Calling this on a system key from outside internal code is intentional only
 * for deliberate operator overrides (e.g. resetting the team anchor after an
 * intentional workspace migration).
 */
export async function setConfig(
  workspaceId: number,
  key: string,
  value: string
): Promise<void> {
  const db = getDb();
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
 * Read a config value for a workspace+key pair.
 * Returns `null` when the row does not exist (absence = unset).
 */
export async function getConfig(
  workspaceId: number,
  key: string
): Promise<string | null> {
  const db = getDb();
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
 * Remove a config entry entirely (absence = unset).
 * No-op if the row does not exist.
 */
export async function unsetConfig(
  workspaceId: number,
  key: string
): Promise<void> {
  const db = getDb();
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

export async function getSlackTeamId(): Promise<string | null> {
  return getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID);
}

export async function setSlackTeamId(teamId: string): Promise<void> {
  return setConfig(ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID, teamId);
}

export async function getPublicUrl(): Promise<string | null> {
  return getConfig(ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL);
}

export async function setPublicUrl(url: string): Promise<void> {
  return setConfig(ORG_WORKSPACE_ID, SystemConfigKeys.PUBLIC_URL, url);
}

// ---------------------------------------------------------------------------
// Operator config helpers (org-level, workspace 0)
// ---------------------------------------------------------------------------

/**
 * Read the org-wide list of approved remote agent domains from workspace 0.
 * Returns an empty array if not configured (which means no remote agents are
 * approved — deny-all semantics enforced in `validateRemoteEndpoint`).
 */
export async function getAllowedRemoteAgentDomains(): Promise<string[]> {
  const raw = await getConfig(
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
  domains: string[]
): Promise<void> {
  return setConfig(
    ORG_WORKSPACE_ID,
    OperatorConfigKeys.REMOTE_AGENT_ALLOWED_DOMAINS,
    JSON.stringify(domains)
  );
}

/**
 * Read the admin avatar URL for a workspace (null = use the default bot icon).
 * Workspace-scoped: each admin instance has its own avatar.
 */
export async function getAdminIconUrl(
  workspaceId: number
): Promise<string | null> {
  return getConfig(workspaceId, OperatorConfigKeys.ADMIN_ICON_URL);
}

/** Set (upsert) the admin avatar URL for a workspace. */
export async function setAdminIconUrl(
  workspaceId: number,
  url: string
): Promise<void> {
  return setConfig(workspaceId, OperatorConfigKeys.ADMIN_ICON_URL, url);
}

/**
 * Read the admin display name for a workspace (null = use the registry row's
 * default). Workspace-scoped: each admin instance has its own name.
 */
export async function getAdminDisplayName(
  workspaceId: number
): Promise<string | null> {
  return getConfig(workspaceId, OperatorConfigKeys.ADMIN_DISPLAY_NAME);
}

/** Set (upsert) the admin display name for a workspace. */
export async function setAdminDisplayName(
  workspaceId: number,
  displayName: string
): Promise<void> {
  return setConfig(
    workspaceId,
    OperatorConfigKeys.ADMIN_DISPLAY_NAME,
    displayName
  );
}
