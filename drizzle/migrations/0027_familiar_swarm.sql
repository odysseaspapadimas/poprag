ALTER TABLE `catalog_config` ADD `include_filters` text DEFAULT ('[]');--> statement-breakpoint
ALTER TABLE `catalog_sync_config` ADD `include_filters` text DEFAULT ('[]');