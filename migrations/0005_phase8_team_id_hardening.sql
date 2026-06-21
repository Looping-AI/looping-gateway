CREATE TABLE `workspace_configs` (
	`workspace_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`workspace_id`, `key`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `slack_users` DROP COLUMN `slack_team_id`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `slack_team_id`;