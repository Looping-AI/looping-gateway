CREATE TABLE `agent_channels` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`workspace_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`agent_name`) REFERENCES `agents`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_channels_agent` ON `agent_channels` (`agent_name`);--> statement-breakpoint
CREATE TABLE `agents` (
	`name` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`a2a_endpoint` text,
	`enabled` integer DEFAULT true NOT NULL,
	`workspace_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `slack_users` (
	`slack_user_id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`is_primary_owner` integer DEFAULT false NOT NULL,
	`is_org_admin` integer DEFAULT false NOT NULL,
	`slack_team_id` text,
	`deleted` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_admins` (
	`workspace_id` integer NOT NULL,
	`slack_user_id` text NOT NULL,
	`source` text DEFAULT 'membership' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`workspace_id`, `slack_user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slack_user_id`) REFERENCES `slack_users`(`slack_user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ws_admins_user` ON `workspace_admins` (`slack_user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`admin_channel_id` text,
	`slack_team_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_admin_channel_id_unique` ON `workspaces` (`admin_channel_id`);