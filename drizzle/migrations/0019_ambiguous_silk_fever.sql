CREATE TABLE `agent_experience` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`order` integer DEFAULT 0,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_experience_agent_idx` ON `agent_experience` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_experience_slug_idx` ON `agent_experience` (`agent_id`,`slug`);--> statement-breakpoint
CREATE TABLE `agent_experience_knowledge` (
	`experience_id` text NOT NULL,
	`knowledge_source_id` text NOT NULL,
	PRIMARY KEY(`experience_id`, `knowledge_source_id`),
	FOREIGN KEY (`experience_id`) REFERENCES `agent_experience`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_source_id`) REFERENCES `knowledge_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_exp_knowledge_exp_idx` ON `agent_experience_knowledge` (`experience_id`);--> statement-breakpoint
CREATE INDEX `agent_exp_knowledge_source_idx` ON `agent_experience_knowledge` (`knowledge_source_id`);