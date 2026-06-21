ALTER TABLE `catalog_config` ADD `active_index_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_product` ADD `index_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `catalog_product_fact` ADD `index_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `catalog_index_version` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `catalog_product_source_record_key_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_product_source_record_key_version_idx` ON `catalog_product` (`source_id`,`record_key`,`index_version`);--> statement-breakpoint
CREATE INDEX `catalog_product_source_version_idx` ON `catalog_product` (`source_id`,`index_version`,`status`);--> statement-breakpoint
CREATE INDEX `catalog_product_fact_source_version_idx` ON `catalog_product_fact` (`source_id`,`index_version`);--> statement-breakpoint
CREATE INDEX `document_chunks_catalog_version_idx` ON `document_chunks` (`source_id`,`catalog_index_version`);--> statement-breakpoint
CREATE TABLE `catalog_index_version` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`source_id` text NOT NULL,
	`catalog_config_id` text NOT NULL,
	`run_id` text,
	`version` integer NOT NULL,
	`status` text DEFAULT 'building' NOT NULL,
	`stats` text,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`promoted_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_source`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`catalog_config_id`) REFERENCES `catalog_config`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_index_version_source_version_idx` ON `catalog_index_version` (`source_id`,`version`);--> statement-breakpoint
CREATE INDEX `catalog_index_version_source_status_idx` ON `catalog_index_version` (`source_id`,`status`);--> statement-breakpoint
CREATE INDEX `catalog_index_version_config_idx` ON `catalog_index_version` (`catalog_config_id`);--> statement-breakpoint
INSERT INTO `catalog_index_version` (
	`id`,
	`agent_id`,
	`source_id`,
	`catalog_config_id`,
	`version`,
	`status`,
	`created_at`,
	`promoted_at`,
	`updated_at`
)
SELECT
	'legacy_' || `knowledge_source_id`,
	`agent_id`,
	`knowledge_source_id`,
	`id`,
	0,
	'active',
	`created_at`,
	`updated_at`,
	`updated_at`
FROM `catalog_config`
WHERE EXISTS (
	SELECT 1
	FROM `catalog_product`
	WHERE `catalog_product`.`source_id` = `catalog_config`.`knowledge_source_id`
);
