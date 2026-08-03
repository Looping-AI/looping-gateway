-- Add `tenant_id` to agents: which agent to address at an endpoint that serves
-- several (A2A spec §8.3.2).
--
-- Required with no default, so existing rows are backfilled in the rebuild
-- below rather than defaulted to '' — a default would make the column optional
-- at every future insert and turn '' into a second sentinel beside
-- `http://{name}.local`. Same shape as 0004, which tightened `a2a_endpoint`.
--
--   built-ins  → their `kind` ('admin', 'onboarding'), which is exactly the
--                tenant `localNamespaceFor` now routes on
--   custom     → their `name`, a best guess: rows registered before this
--                existed carry no tenant, and the remote will reject a
--                dispatch naming the wrong one with a 401. Those agents have
--                to be re-registered against a tenant-aware host anyway, since
--                the endpoint audience changed in the same release.
--
-- The `PRAGMA foreign_keys=OFF` drizzle-kit emits here does nothing: D1 runs a
-- migration inside an implicit transaction, and SQLite ignores `foreign_keys`
-- inside one. `DROP TABLE agents` then performs an implicit DELETE that orphans
-- every child row — agent_channels, agent_tasks and hitl_requests all hold a FK
-- to agents.name — and the migration dies with FOREIGN KEY constraint failed.
--
-- `PRAGMA defer_foreign_keys`, D1's documented replacement, is not enough on its
-- own. It only moves the check to the commit: DROP TABLE increments SQLite's
-- deferred-violation counter once per orphaned row, and renaming a new `agents`
-- into place never decrements it, because nothing re-examines those rows. The
-- same error arrives a moment later.
--
-- So the children move out of the way first, as 0009 and 0011 did for the one
-- child that existed then. Their column-by-column backup tables are replaced by
-- CREATE TABLE ... AS SELECT *, which keeps this migration from having to
-- restate three schemas that have each already been rewritten at least once.
-- The whole file is one transaction, so the children are never observably empty
-- and a failure at any point rolls back to the pre-0019 state.
CREATE TABLE `__bkp_agent_channels` AS SELECT * FROM `agent_channels`;--> statement-breakpoint
CREATE TABLE `__bkp_agent_tasks` AS SELECT * FROM `agent_tasks`;--> statement-breakpoint
CREATE TABLE `__bkp_hitl_requests` AS SELECT * FROM `hitl_requests`;--> statement-breakpoint
DELETE FROM `agent_channels`;--> statement-breakpoint
DELETE FROM `agent_tasks`;--> statement-breakpoint
DELETE FROM `hitl_requests`;--> statement-breakpoint

-- Both CHECKs name their column unqualified, as 0011 wrote it. Qualified, they
-- would say `__new_agents` and the surviving constraint would depend on ALTER
-- TABLE RENAME rewriting the reference; nothing here needs the qualifier.
CREATE TABLE `__new_agents` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`icon_url` text,
	`a2a_endpoint` text NOT NULL,
	`tenant_id` text NOT NULL,
	`card_signing_jku` text,
	`card_signing_kid` text,
	`enabled` integer DEFAULT true NOT NULL,
	`notify_on` text NOT NULL,
	`workspace_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agents_name_lowercase" CHECK("name" = lower("name")),
	CONSTRAINT "agents_tenant_id_nonempty" CHECK("tenant_id" <> '')
);
--> statement-breakpoint
INSERT INTO `__new_agents`("name", "kind", "display_name", "icon_url", "a2a_endpoint", "tenant_id", "card_signing_jku", "card_signing_kid", "enabled", "notify_on", "workspace_id", "created_at", "updated_at") SELECT "name", "kind", "display_name", "icon_url", "a2a_endpoint", CASE WHEN "kind" = 'custom' THEN "name" ELSE "kind" END, "card_signing_jku", "card_signing_kid", "enabled", "notify_on", "workspace_id", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
CREATE INDEX `idx_agents_workspace_id` ON `agents` (`workspace_id`);--> statement-breakpoint

-- Restore the children. Every agent name survived the rebuild unchanged, so
-- each row finds the parent it had before.
INSERT INTO `agent_channels` SELECT * FROM `__bkp_agent_channels`;--> statement-breakpoint
INSERT INTO `agent_tasks` SELECT * FROM `__bkp_agent_tasks`;--> statement-breakpoint
INSERT INTO `hitl_requests` SELECT * FROM `__bkp_hitl_requests`;--> statement-breakpoint
DROP TABLE `__bkp_agent_channels`;--> statement-breakpoint
DROP TABLE `__bkp_agent_tasks`;--> statement-breakpoint
DROP TABLE `__bkp_hitl_requests`;