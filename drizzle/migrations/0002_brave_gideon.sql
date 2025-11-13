CREATE TABLE `agent` (
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
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_slug_unique` ON `agent` (`slug`);--> statement-breakpoint
CREATE INDEX `agent_slug_idx` ON `agent` (`slug`);--> statement-breakpoint
CREATE INDEX `agent_status_idx` ON `agent` (`status`);--> statement-breakpoint
CREATE INDEX `agent_created_by_idx` ON `agent` (`created_by`);--> statement-breakpoint
CREATE TABLE `agent_index_pin` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`index_version` integer NOT NULL,
	`pinned_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`pinned_by` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pinned_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_index_pin_agent_id_unique` ON `agent_index_pin` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_index_pin_agent_idx` ON `agent_index_pin` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agent_model_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`model_alias` text NOT NULL,
	`temperature` integer,
	`top_p` integer,
	`presence_penalty` integer,
	`frequency_penalty` integer,
	`max_tokens` integer,
	`response_format` text,
	`enabled_tools` text,
	`effective_from` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`effective_to` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_alias`) REFERENCES `model_alias`(`alias`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_model_policy_agent_idx` ON `agent_model_policy` (`agent_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`event_type` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`diff` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE TABLE `chunk` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`source_id` text NOT NULL,
	`text` text NOT NULL,
	`meta` text,
	`embedding_dim` integer,
	`index_version` integer NOT NULL,
	`vectorize_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chunk_agent_version_idx` ON `chunk` (`agent_id`,`index_version`);--> statement-breakpoint
CREATE INDEX `chunk_source_idx` ON `chunk` (`source_id`);--> statement-breakpoint
CREATE TABLE `eval_dataset` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`items` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_source` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`type` text DEFAULT 'r2-file' NOT NULL,
	`r2_bucket` text,
	`r2_key` text,
	`file_name` text,
	`mime` text,
	`bytes` integer,
	`checksum` text,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`parser_errors` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_source_agent_idx` ON `knowledge_source` (`agent_id`);--> statement-breakpoint
CREATE INDEX `knowledge_source_status_idx` ON `knowledge_source` (`agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `model_alias` (
	`alias` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`gateway_route` text,
	`caps` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_alias_provider_idx` ON `model_alias` (`provider`);--> statement-breakpoint
CREATE TABLE `prompt` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`key` text DEFAULT 'system' NOT NULL,
	`description` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prompt_agent_idx` ON `prompt` (`agent_id`);--> statement-breakpoint
CREATE INDEX `prompt_agent_key_idx` ON `prompt` (`agent_id`,`key`);--> statement-breakpoint
CREATE TABLE `prompt_version` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_id` text NOT NULL,
	`version` integer NOT NULL,
	`label` text DEFAULT 'none' NOT NULL,
	`content` text NOT NULL,
	`variables` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`changelog` text,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompt`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `prompt_version_prompt_idx` ON `prompt_version` (`prompt_id`,`version`);--> statement-breakpoint
CREATE INDEX `prompt_version_label_idx` ON `prompt_version` (`prompt_id`,`label`);--> statement-breakpoint
CREATE TABLE `run_metric` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tokens` integer,
	`cost_microcents` integer,
	`latency_ms` integer,
	`error_type` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_metric_agent_idx` ON `run_metric` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `transcript` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`initiated_by` text,
	`request` text,
	`response` text,
	`usage` text,
	`latency_ms` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`initiated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transcript_agent_idx` ON `transcript` (`agent_id`);--> statement-breakpoint
CREATE INDEX `transcript_conversation_idx` ON `transcript` (`conversation_id`);