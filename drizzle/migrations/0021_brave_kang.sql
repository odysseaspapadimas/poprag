ALTER TABLE `knowledge_source` ADD `progress_message` text;--> statement-breakpoint
ALTER TABLE `knowledge_source` ADD `retry_count` integer DEFAULT 0 NOT NULL;