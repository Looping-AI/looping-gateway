-- Backfill built-in agents (seeded in 0001 without an endpoint) with a local
-- sentinel before tightening a2a_endpoint to NOT NULL. Routing is by agent
-- `kind`, so these `http://{name}.local` URLs are never actually fetched.
UPDATE `agents` SET `a2a_endpoint` = 'http://' || `name` || '.local' WHERE `a2a_endpoint` IS NULL;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`a2a_endpoint` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`workspace_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agents`("name", "kind", "display_name", "a2a_endpoint", "enabled", "workspace_id", "created_at", "updated_at") SELECT "name", "kind", "display_name", "a2a_endpoint", "enabled", "workspace_id", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_agents_workspace_id` ON `agents` (`workspace_id`);
