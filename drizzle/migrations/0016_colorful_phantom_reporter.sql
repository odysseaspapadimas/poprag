-- Create firebase_user table
CREATE TABLE `firebase_user` (
	`uid` text PRIMARY KEY NOT NULL,
	`email` text,
	`display_name` text,
	`photo_url` text,
	`sign_in_provider` text,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`total_requests` integer DEFAULT 0 NOT NULL,
	`linked_user_id` text,
	FOREIGN KEY (`linked_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `firebase_user_email_idx` ON `firebase_user` (`email`);
--> statement-breakpoint
CREATE INDEX `firebase_user_linked_user_idx` ON `firebase_user` (`linked_user_id`);
--> statement-breakpoint
-- Add firebase_uid to run_metric
ALTER TABLE `run_metric` ADD `firebase_uid` text;
--> statement-breakpoint
CREATE INDEX `run_metric_firebase_uid_idx` ON `run_metric` (`firebase_uid`);
--> statement-breakpoint
-- Add firebase_uid to transcript
ALTER TABLE `transcript` ADD `firebase_uid` text;
--> statement-breakpoint
CREATE INDEX `transcript_firebase_uid_idx` ON `transcript` (`firebase_uid`);
