CREATE TABLE `agent_tasks` (
	`token` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`agent_name` text NOT NULL,
	`channel_id` text NOT NULL,
	`reply_thread_ts` text,
	`event_id` text NOT NULL,
	`display_name` text NOT NULL,
	`icon_url` text,
	`workspace_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`agent_name`) REFERENCES `agents`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_created_at` ON `agent_tasks` (`created_at`);