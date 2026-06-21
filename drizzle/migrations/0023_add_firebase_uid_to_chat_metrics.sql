ALTER TABLE `transcript` ADD `firebase_uid` text;--> statement-breakpoint
CREATE INDEX `transcript_firebase_uid_idx` ON `transcript` (`firebase_uid`);--> statement-breakpoint
ALTER TABLE `run_metric` ADD `firebase_uid` text;--> statement-breakpoint
CREATE INDEX `run_metric_firebase_uid_idx` ON `run_metric` (`firebase_uid`);
