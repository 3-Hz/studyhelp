ALTER TABLE `sessions` ADD `lecture_ids` text;--> statement-breakpoint
UPDATE `sessions` SET `lecture_ids` = '[' || `lecture_id` || ']' WHERE `lecture_id` IS NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `type` = 'review' WHERE `type` = 'same_day';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`lecture_ids` text,
	`plan` text,
	`debrief` text,
	`outcomes` text,
	`minutes` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "type", "lecture_ids", "plan", "debrief", "outcomes", "minutes", "started_at", "ended_at") SELECT "id", "type", "lecture_ids", "plan", "debrief", "outcomes", "minutes", "started_at", "ended_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
