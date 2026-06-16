import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index
} from "drizzle-orm/sqlite-core";

// Unix-seconds timestamp column with a SQLite-side default. Reused across tables.
const timestamp = (name: string) =>
  integer(name)
    .notNull()
    .default(sql`(unixepoch())`);

/**
 * Workspaces — logical sub-orgs, each mapped to a Slack admin channel.
 * `id` is OUR id (not a Slack team id) and is NOT autoincrement so that `0`
 * (the org sentinel, see ORG_WORKSPACE_ID) can be reserved explicitly.
 * Membership of a workspace's `adminChannelId` ⇒ admin of that workspace.
 */
export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  adminChannelId: text("admin_channel_id").unique(),
  slackTeamId: text("slack_team_id"),
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
  slackTeamId: text("slack_team_id"),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at")
});

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
    a2aEndpoint: text("a2a_endpoint"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    workspaceId: integer("workspace_id").references(() => workspaces.id),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at")
  },
  (t) => [index("idx_agents_workspace_id").on(t.workspaceId)]
);

/** Channel → agent allowlist. Multiple agents can share a channel; ::name disambiguates. */
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
