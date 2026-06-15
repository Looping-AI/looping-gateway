--> statement-breakpoint
DROP TABLE IF EXISTS `agent_channels`;
--> statement-breakpoint
CREATE TABLE `agent_channels` (
	`channel_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`workspace_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`channel_id`, `agent_name`),
	FOREIGN KEY (`agent_name`) REFERENCES `agents`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_channels_agent` ON `agent_channels` (`agent_name`);
