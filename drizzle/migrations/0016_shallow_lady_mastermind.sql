PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_deployed_at` integer,
	`rag_enabled` integer DEFAULT true NOT NULL,
	`contextual_embeddings_enabled` integer DEFAULT false NOT NULL,
	`rewrite_query` integer DEFAULT true NOT NULL,
	`rewrite_model` text,
	`skip_intent_classification` integer DEFAULT false NOT NULL,
	`intent_model` text,
	`query_variations_count` integer DEFAULT 3,
	`rerank` integer DEFAULT true NOT NULL,
	`rerank_model` text,
	`top_k` integer DEFAULT 5,
	`min_similarity` integer DEFAULT 15,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent`("id", "name", "slug", "description", "status", "visibility", "created_by", "created_at", "updated_at", "last_deployed_at", "rag_enabled", "contextual_embeddings_enabled", "rewrite_query", "rewrite_model", "skip_intent_classification", "intent_model", "query_variations_count", "rerank", "rerank_model", "top_k", "min_similarity") SELECT "id", "name", "slug", "description", "status", "visibility", "created_by", "created_at", "updated_at", "last_deployed_at", "rag_enabled", "contextual_embeddings_enabled", "rewrite_query", "rewrite_model", "skip_intent_classification", "intent_model", "query_variations_count", "rerank", "rerank_model", "top_k", "min_similarity" FROM `agent`;--> statement-breakpoint
DROP TABLE `agent`;--> statement-breakpoint
ALTER TABLE `__new_agent` RENAME TO `agent`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_slug_unique` ON `agent` (`slug`);--> statement-breakpoint
CREATE INDEX `agent_slug_idx` ON `agent` (`slug`);--> statement-breakpoint
CREATE INDEX `agent_status_idx` ON `agent` (`status`);--> statement-breakpoint
CREATE INDEX `agent_created_by_idx` ON `agent` (`created_by`);
