CREATE TABLE `hitl_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`task_id` text,
	`context_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_ts` text,
	`slack_message_ts` text,
	`request_kind` text NOT NULL,
	`prompt_text` text NOT NULL,
	`options_json` text,
	`allow_freeform` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'awaiting' NOT NULL,
	`answered_by` text,
	`answered_option_id` text,
	`answer_text` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deadline_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`agent_name`) REFERENCES `agents`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_hitl_requests_token` ON `hitl_requests` (`token`);--> statement-breakpoint
CREATE INDEX `idx_hitl_requests_status_deadline` ON `hitl_requests` (`status`,`deadline_at`);--> statement-breakpoint
CREATE INDEX `idx_hitl_requests_created_at` ON `hitl_requests` (`created_at`);