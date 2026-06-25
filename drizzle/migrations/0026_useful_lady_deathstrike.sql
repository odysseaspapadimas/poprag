ALTER TABLE `catalog_config` ADD `scope_name` text;--> statement-breakpoint
ALTER TABLE `catalog_config` ADD `scope_aliases` text DEFAULT ('[]');