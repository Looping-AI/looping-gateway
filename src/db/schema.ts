import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  check
} from "drizzle-orm/sqlite-core";

// Unix-seconds timestamp column with a SQLite-side default. Reused across tables.
const timestamp = (name: string) =>
  integer(name)
    .notNull()
    .default(sql`(unixepoch())`);

/**
 * Workspaces — logical sub-orgs, each mapped to a Slack admin channel.
 * `id` is OUR id (not a Slack team id). It's a plain INTEGER PRIMARY KEY, i.e.
 * the SQLite rowid: omit it on insert and SQLite assigns max(id)+1. `0`
 * (ORG_WORKSPACE_ID) is seeded explicitly, so new rows auto-allocate from 1.
 * Membership of a workspace's `adminChannelId` ⇒ admin of that workspace.
 */
export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  adminChannelId: text("admin_channel_id").unique(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at")
});

/**
 * Global Slack user registry, keyed by the stable Slack user id (`U…`).
 * Owner/admin flags are authoritative from `users.list` (reconcile); membership
 * events only ever upsert the id, never these flags.
 */
export const slackUsers = sqliteTable("slack_users", {
  slackUserId: text("slack_user_id").primaryKey(),
  displayName: text("display_name"),
  isPrimaryOwner: integer("is_primary_owner", { mode: "boolean" })
    .notNull()
    .default(false),
  isOrgAdmin: integer("is_org_admin", { mode: "boolean" })
    .notNull()
    .default(false),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at")
});

/**
 * Slack channel registry, keyed by the stable Slack channel id (`C…`). Kept
 * upserted by reconcile from the `conversations.list` traversal it already does,
 * so the message hot path resolves a channel name with a single D1 read instead
 * of a Slack call. Only named conversations (public/private channels) land here;
 * DMs/MPIMs miss and the hot path falls back to the raw id.
 */
export const slackChannels = sqliteTable(
  "slack_channels",
  {
    channelId: text("channel_id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at")
  },
  (t) => [index("idx_slack_channels_name").on(t.name)]
);

/**
 * Workspace admins — one row per (workspace, user). This join table IS the
 * source of `adminWorkspaces`; being a member of a workspace's admin channel
 * lands a row here. FK is declared for intent/tests; cascades are done
 * explicitly in code (D1 does not reliably enforce foreign_keys at runtime).
 */
export const workspaceAdmins = sqliteTable(
  "workspace_admins",
  {
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    slackUserId: text("slack_user_id")
      .notNull()
      .references(() => slackUsers.slackUserId),
    source: text("source", { enum: ["membership", "bootstrap"] })
      .notNull()
      .default("membership"),
    createdAt: timestamp("created_at")
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.slackUserId] }),
    index("idx_ws_admins_user").on(t.slackUserId)
  ]
);

/**
 * Agent registry. Built-in `admin`/`onboarding` rows are seeded by
 * migrations/0001_seed_builtins.sql at deploy time. CRUD is Phase 4.
 */
export const agents = sqliteTable(
  "agents",
  {
    name: text("name").primaryKey(),
    kind: text("kind", { enum: ["admin", "onboarding", "custom"] }).notNull(),
    displayName: text("display_name"),
    // Optional icon URL derived from the agent's published AgentCard (custom agents only).
    iconUrl: text("icon_url"),
    // Always set: custom agents carry a real HTTP endpoint; built-ins use an
    // `http://{name}.local` sentinel. Routing is by `kind`, not this value.
    a2aEndpoint: text("a2a_endpoint").notNull(),
    // Pinned AgentCard signing identity for custom agents (Trust-On-First-Use).
    // Verified at registration; a later card signed by a different key is
    // rejected. Null for built-in local agents (admin/onboarding are unsigned).
    cardSigningJku: text("card_signing_jku"),
    cardSigningKid: text("card_signing_kid"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // When the agent is woken: `mention` = only on a name mention (machine or
    // display name); `channel_messages` = every channel message. Required (no
    // default) so a missing value is rejected, not silently coerced.
    notifyOn: text("notify_on", {
      enum: ["mention", "channel_messages"]
    }).notNull(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at")
  },
  (t) => [
    index("idx_agents_workspace_id").on(t.workspaceId),
    check("agents_name_lowercase", sql`${t.name} = lower(${t.name})`)
  ]
);

/** Channel → agent allowlist. Multiple agents can share a channel; agent names disambiguate. */
export const agentChannels = sqliteTable(
  "agent_channels",
  {
    channelId: text("channel_id").notNull(),
    agentName: text("agent_name")
      .notNull()
      .references(() => agents.name),
    workspaceId: integer("workspace_id").references(() => workspaces.id),
    createdAt: timestamp("created_at")
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.agentName] }),
    index("idx_agent_channels_agent").on(t.agentName)
  ]
);

/**
 * Per-workspace key/value configuration store. The composite PK
 * `(workspace_id, key)` allows each workspace to hold independent values for
 * the same key (e.g. ws0 stores the global Slack team anchor). The value
 * column is NOT NULL — absence of a key is represented by no row, not a null.
 *
 * System keys (written only by internal code) are exported from
 * `src/db/models/workspace-configs.ts` under `SystemConfigKeys`; ad-hoc
 * admin/operator keys live alongside them without coupling the schema.
 */
export const workspaceConfigs = sqliteTable(
  "workspace_configs",
  {
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at")
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })]
);
