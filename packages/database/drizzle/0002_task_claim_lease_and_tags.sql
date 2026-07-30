ALTER TABLE `projects` ADD `tags` json;--> statement-breakpoint
ALTER TABLE `projects` ADD `last_task_number` bigint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tags` json;--> statement-breakpoint
ALTER TABLE `tasks` ADD `claim_expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `tasks` ADD `claimed_by_agent_run_id` char(26);--> statement-breakpoint
CREATE INDEX `idx_tasks_project_created_at` ON `tasks` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_claim_expires_at` ON `tasks` (`status`,`claim_expires_at`);