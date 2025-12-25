ALTER TABLE `agent` ADD `intent_model` text;--> statement-breakpoint
ALTER TABLE `agent` ADD `query_variations_count` integer DEFAULT 3;