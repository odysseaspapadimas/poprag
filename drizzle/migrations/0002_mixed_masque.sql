CREATE TABLE `chat_image` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`r2_bucket` text,
	`r2_key` text,
	`file_name` text,
	`mime` text,
	`bytes` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_image_agent_idx` ON `chat_image` (`agent_id`);--> statement-breakpoint
CREATE INDEX `chat_image_conversation_idx` ON `chat_image` (`conversation_id`);