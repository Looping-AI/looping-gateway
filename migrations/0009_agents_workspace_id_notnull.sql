-- Enforce NOT NULL on agents.workspace_id at the DB level.
-- D1 ignores PRAGMA foreign_keys=OFF, so table recreation requires temporarily
-- clearing the child table (agent_channels) that holds a FK to agents.
-- We save the rows to a plain backup table, wipe the child, recreate agents
-- with NOT NULL, then restore. No data is lost.

-- Step 1: save agent_channels rows
CREATE TABLE `__ac_bkp` (
	`channel_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`workspace_id` integer,
	`created_at` integer
);
--> statement-breakpoint
INSERT INTO `__ac_bkp` (`channel_id`, `agent_name`, `workspace_id`, `created_at`)
	SELECT `channel_id`, `agent_name`, `workspace_id`, `created_at` FROM `agent_channels`;
--> statement-breakpoint

-- Step 2: clear child rows so DROP TABLE agents has no FK dependents
DELETE FROM `agent_channels`;
--> statement-breakpoint

-- Step 3: recreate agents with workspace_id NOT NULL
CREATE TABLE `__new_agents` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`a2a_endpoint` text NOT NULL,
	`card_signing_jku` text,
	`card_signing_kid` text,
	`enabled` integer DEFAULT true NOT NULL,
	`workspace_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agents` (`name`, `kind`, `display_name`, `a2a_endpoint`, `card_signing_jku`, `card_signing_kid`, `enabled`, `workspace_id`, `created_at`, `updated_at`)
	SELECT `name`, `kind`, `display_name`, `a2a_endpoint`, `card_signing_jku`, `card_signing_kid`, `enabled`, `workspace_id`, `created_at`, `updated_at` FROM `agents`;
--> statement-breakpoint
DROP TABLE `agents`;
--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;
--> statement-breakpoint
CREATE INDEX `idx_agents_workspace_id` ON `agents` (`workspace_id`);
--> statement-breakpoint

-- Step 4: restore agent_channels
INSERT INTO `agent_channels` (`channel_id`, `agent_name`, `workspace_id`, `created_at`)
	SELECT `channel_id`, `agent_name`, `workspace_id`, `created_at` FROM `__ac_bkp`;
--> statement-breakpoint
DROP TABLE `__ac_bkp`;
