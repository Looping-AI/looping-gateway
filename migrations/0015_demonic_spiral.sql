ALTER TABLE `agent_tasks` ADD `message_ts` text;--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD `cancel_requested` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_channel_message_ts` ON `agent_tasks` (`channel_id`,`message_ts`);