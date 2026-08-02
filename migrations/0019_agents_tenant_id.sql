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
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "agents_name_lowercase" CHECK("__new_agents"."name" = lower("__new_agents"."name")),
	CONSTRAINT "agents_tenant_id_nonempty" CHECK("__new_agents"."tenant_id" <> '')
);
--> statement-breakpoint
INSERT INTO `__new_agents`("name", "kind", "display_name", "icon_url", "a2a_endpoint", "tenant_id", "card_signing_jku", "card_signing_kid", "enabled", "notify_on", "workspace_id", "created_at", "updated_at") SELECT "name", "kind", "display_name", "icon_url", "a2a_endpoint", CASE WHEN "kind" = 'custom' THEN "name" ELSE "kind" END, "card_signing_jku", "card_signing_kid", "enabled", "notify_on", "workspace_id", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_agents_workspace_id` ON `agents` (`workspace_id`);