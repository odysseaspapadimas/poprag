CREATE TABLE `catalog_config` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`knowledge_source_id` text NOT NULL,
	`experience_id` text,
	`name` text NOT NULL,
	`origin` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`stable_key_field` text NOT NULL,
	`updated_at_field` text,
	`deletion_field` text,
	`deletion_inactive_values` text,
	`title_field` text NOT NULL,
	`searchable_fields` text DEFAULT ('[]'),
	`exact_match_fields` text DEFAULT ('[]'),
	`filterable_fields` text DEFAULT ('[]'),
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_source_id`) REFERENCES `knowledge_source`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`experience_id`) REFERENCES `agent_experience`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_config_knowledge_source_id_unique` ON `catalog_config` (`knowledge_source_id`);--> statement-breakpoint
CREATE INDEX `catalog_config_agent_idx` ON `catalog_config` (`agent_id`);--> statement-breakpoint
CREATE INDEX `catalog_config_source_idx` ON `catalog_config` (`knowledge_source_id`);--> statement-breakpoint
CREATE INDEX `catalog_config_enabled_idx` ON `catalog_config` (`agent_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `catalog_config_origin_idx` ON `catalog_config` (`origin`);--> statement-breakpoint
CREATE TABLE `catalog_product_fact` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`source_id` text NOT NULL,
	`product_id` text NOT NULL,
	`field_path` text NOT NULL,
	`role` text NOT NULL,
	`value` text NOT NULL,
	`normalized_value` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_source`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `catalog_product`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `catalog_product_fact_agent_idx` ON `catalog_product_fact` (`agent_id`);--> statement-breakpoint
CREATE INDEX `catalog_product_fact_source_idx` ON `catalog_product_fact` (`source_id`);--> statement-breakpoint
CREATE INDEX `catalog_product_fact_product_idx` ON `catalog_product_fact` (`product_id`);--> statement-breakpoint
CREATE INDEX `catalog_product_fact_field_idx` ON `catalog_product_fact` (`field_path`);--> statement-breakpoint
CREATE INDEX `catalog_product_fact_lookup_idx` ON `catalog_product_fact` (`agent_id`,`role`,`normalized_value`);--> statement-breakpoint
CREATE INDEX `catalog_product_fact_filter_idx` ON `catalog_product_fact` (`agent_id`,`field_path`,`normalized_value`);--> statement-breakpoint
ALTER TABLE `catalog_sync_config` ADD `catalog_config_id` text REFERENCES catalog_config(id);--> statement-breakpoint
CREATE INDEX `catalog_sync_config_catalog_idx` ON `catalog_sync_config` (`catalog_config_id`);--> statement-breakpoint
INSERT INTO `catalog_config` (
	`id`,
	`agent_id`,
	`knowledge_source_id`,
	`experience_id`,
	`name`,
	`origin`,
	`enabled`,
	`stable_key_field`,
	`updated_at_field`,
	`deletion_field`,
	`deletion_inactive_values`,
	`title_field`,
	`searchable_fields`,
	`exact_match_fields`,
	`filterable_fields`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`agent_id`,
	`knowledge_source_id`,
	`experience_id`,
	`name`,
	'api',
	`enabled`,
	`stable_key_field`,
	`updated_at_field`,
	`deletion_field`,
	`deletion_inactive_values`,
	`title_field`,
	coalesce(`searchable_fields`, '[]'),
	coalesce(`exact_match_fields`, '[]'),
	'[]',
	`created_at`,
	`updated_at`
FROM `catalog_sync_config`
WHERE NOT EXISTS (
	SELECT 1
	FROM `catalog_config`
	WHERE `catalog_config`.`knowledge_source_id` = `catalog_sync_config`.`knowledge_source_id`
);
--> statement-breakpoint
UPDATE `catalog_sync_config`
SET `catalog_config_id` = `id`
WHERE `catalog_config_id` IS NULL;
