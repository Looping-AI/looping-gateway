-- Tighten `message_ts` to NOT NULL: it is the only lookup key the 🛑 stop
-- reaction has (a reaction event carries just item.channel + item.ts), so a NULL
-- makes a row permanently uncancelable.
--
-- Rows written before 0015 added the column have no trigger ts to recover. '' is
-- an inert sentinel: it satisfies NOT NULL and never matches a real Slack ts, so
-- a 🛑 finds nothing for them (exactly today's behaviour), while the row itself
-- survives so any in-flight push callback still correlates and posts its reply.
-- The maintenance sweep clears them within 30 days.
UPDATE `agent_tasks` SET `message_ts` = '' WHERE `message_ts` IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_tasks` (
	`token` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`agent_name` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_ts` text NOT NULL,
	`reply_thread_ts` text,
	`event_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`received_message_ids` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`agent_name`) REFERENCES `agents`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent_tasks`("token", "task_id", "agent_name", "channel_id", "message_ts", "reply_thread_ts", "event_id", "status", "cancel_requested", "last_error", "received_message_ids", "created_at", "completed_at") SELECT "token", "task_id", "agent_name", "channel_id", "message_ts", "reply_thread_ts", "event_id", "status", "cancel_requested", "last_error", "received_message_ids", "created_at", "completed_at" FROM `agent_tasks`;--> statement-breakpoint
DROP TABLE `agent_tasks`;--> statement-breakpoint
ALTER TABLE `__new_agent_tasks` RENAME TO `agent_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_created_at` ON `agent_tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_channel_message_ts` ON `agent_tasks` (`channel_id`,`message_ts`);--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_event_id` ON `agent_tasks` (`event_id`);