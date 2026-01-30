ALTER TABLE `model_alias` ADD `model_type` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `model_alias` ADD `embedding_dimensions` integer;