CREATE TABLE `catalog_product` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`source_id` text NOT NULL,
	`record_key` text NOT NULL,
	`record_hash` text NOT NULL,
	`title` text,
	`search_text` text,
	`data` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` integer,
	`deactivated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_product_source_record_key_idx` ON `catalog_product` (`source_id`,`record_key`);--> statement-breakpoint
CREATE INDEX `catalog_product_agent_idx` ON `catalog_product` (`agent_id`);--> statement-breakpoint
CREATE INDEX `catalog_product_source_status_idx` ON `catalog_product` (`source_id`,`status`);--> statement-breakpoint
CREATE INDEX `catalog_product_record_key_idx` ON `catalog_product` (`record_key`);--> statement-breakpoint
CREATE TABLE `catalog_sync_config` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`knowledge_source_id` text NOT NULL,
	`experience_id` text,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`snapshot_url` text NOT NULL,
	`diff_url` text NOT NULL,
	`auth_header_name` text,
	`auth_secret_name` text,
	`updated_since_param` text DEFAULT 'effectiveUpdatedAfter' NOT NULL,
	`item_path` text DEFAULT '' NOT NULL,
	`stable_key_field` text NOT NULL,
	`updated_at_field` text,
	`deletion_field` text,
	`deletion_inactive_values` text,
	`title_field` text NOT NULL,
	`searchable_fields` text DEFAULT ('[]'),
	`exact_match_fields` text DEFAULT ('[]'),
	`sync_interval_days` integer DEFAULT 7 NOT NULL,
	`schedule_weekday_utc` integer DEFAULT 1 NOT NULL,
	`schedule_hour_utc` integer DEFAULT 3 NOT NULL,
	`next_run_at` integer,
	`cursor_last_successful_at` integer,
	`last_checked_at` integer,
	`last_successful_sync_at` integer,
	`last_run_id` text,
	`last_run_status` text,
	`last_run_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_source_id`) REFERENCES `knowledge_source`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`experience_id`) REFERENCES `agent_experience`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_sync_config_knowledge_source_id_unique` ON `catalog_sync_config` (`knowledge_source_id`);--> statement-breakpoint
CREATE INDEX `catalog_sync_config_agent_idx` ON `catalog_sync_config` (`agent_id`);--> statement-breakpoint
CREATE INDEX `catalog_sync_config_due_idx` ON `catalog_sync_config` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `catalog_sync_config_source_idx` ON `catalog_sync_config` (`knowledge_source_id`);--> statement-breakpoint
CREATE TABLE `catalog_sync_run` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`knowledge_source_id` text NOT NULL,
	`workflow_instance_id` text,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`checked_since` integer,
	`next_cursor_at` integer,
	`raw_r2_key` text,
	`stats` text,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`config_id`) REFERENCES `catalog_sync_config`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_source_id`) REFERENCES `knowledge_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `catalog_sync_run_config_idx` ON `catalog_sync_run` (`config_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `catalog_sync_run_source_idx` ON `catalog_sync_run` (`knowledge_source_id`);--> statement-breakpoint
CREATE INDEX `catalog_sync_run_status_idx` ON `catalog_sync_run` (`status`);--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `product_id` text REFERENCES catalog_product(id);--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `record_key` text;--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `record_hash` text;--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `metadata` text;--> statement-breakpoint
CREATE INDEX `document_chunks_product_idx` ON `document_chunks` (`product_id`);--> statement-breakpoint
CREATE INDEX `document_chunks_record_key_idx` ON `document_chunks` (`source_id`,`record_key`);
