ALTER TABLE `agent` ADD `top_k` integer DEFAULT 5;--> statement-breakpoint
ALTER TABLE `agent` ADD `min_similarity` integer DEFAULT 30;