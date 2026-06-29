-- Add agents.notify_on: when an agent is woken — `mention` (name mention only)
-- or `channel_messages` (every channel message). Enforced NOT NULL with no
-- default, so a missing value is rejected at insert rather than silently
-- coerced. Backfill: built-in admin is a co-worker (channel_messages); every
-- other existing agent keeps mention-only behaviour.
--
-- D1 ignores PRAGMA foreign_keys=OFF, so table recreation requires temporarily
-- clearing the child table (agent_channels) that holds a FK to agents. We save
-- the rows to a backup table, wipe the child, recreate agents, then restore.

-- Step 1: add the column nullable so existing rows survive, then backfill.
ALTER TABLE `agents` ADD COLUMN `notify_on` text;
--> statement-breakpoint
UPDATE `agents` SET `notify_on` = 'channel_messages' WHERE `name` = 'admin';
--> statement-breakpoint
UPDATE `agents` SET `notify_on` = 'mention' WHERE `notify_on` IS NULL;
--> statement-breakpoint

-- Step 2: save agent_channels rows
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

-- Step 3: clear child rows so DROP TABLE agents has no FK dependents
DELETE FROM `agent_channels`;
--> statement-breakpoint

-- Step 4: recreate agents with notify_on NOT NULL and no default
CREATE TABLE `__new_agents` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`a2a_endpoint` text NOT NULL,
	`card_signing_jku` text,
	`card_signing_kid` text,
	`enabled` integer DEFAULT true NOT NULL,
	`notify_on` text NOT NULL,
	`workspace_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agents` (`name`, `kind`, `display_name`, `a2a_endpoint`, `card_signing_jku`, `card_signing_kid`, `enabled`, `notify_on`, `workspace_id`, `created_at`, `updated_at`)
	SELECT `name`, `kind`, `display_name`, `a2a_endpoint`, `card_signing_jku`, `card_signing_kid`, `enabled`, `notify_on`, `workspace_id`, `created_at`, `updated_at` FROM `agents`;
--> statement-breakpoint
DROP TABLE `agents`;
--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;
--> statement-breakpoint
CREATE INDEX `idx_agents_workspace_id` ON `agents` (`workspace_id`);
--> statement-breakpoint

-- Step 5: restore agent_channels
INSERT INTO `agent_channels` (`channel_id`, `agent_name`, `workspace_id`, `created_at`)
	SELECT `channel_id`, `agent_name`, `workspace_id`, `created_at` FROM `__ac_bkp`;
--> statement-breakpoint
DROP TABLE `__ac_bkp`;
