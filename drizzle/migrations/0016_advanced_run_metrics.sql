ALTER TABLE `run_metric` ADD COLUMN `conversation_id` text;--> statement-breakpoint
ALTER TABLE `run_metric` ADD COLUMN `initiated_by` text;--> statement-breakpoint
ALTER TABLE `run_metric` ADD COLUMN `model_alias` text;--> statement-breakpoint
ALTER TABLE `run_metric` ADD COLUMN `prompt_tokens` integer;--> statement-breakpoint
ALTER TABLE `run_metric` ADD COLUMN `completion_tokens` integer;--> statement-breakpoint
ALTER TABLE `run_metric` ADD COLUMN `total_tokens` integer;--> statement-breakpoint
CREATE INDEX `run_metric_run_idx` ON `run_metric` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_metric_conversation_idx` ON `run_metric` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `run_metric_initiated_by_idx` ON `run_metric` (`initiated_by`);
