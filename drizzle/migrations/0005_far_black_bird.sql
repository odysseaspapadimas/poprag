ALTER TABLE `agent` ADD `rag_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `agent` ADD `rewrite_query` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `agent` ADD `rewrite_model` text;--> statement-breakpoint
ALTER TABLE `agent` ADD `rerank` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `agent` ADD `rerank_model` text;--> statement-breakpoint
ALTER TABLE `run_metric` ADD `time_to_first_token_ms` integer;