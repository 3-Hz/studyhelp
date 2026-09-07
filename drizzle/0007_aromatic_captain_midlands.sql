PRAGMA foreign_keys=OFF;--> statement-breakpoint
DELETE FROM `performances` WHERE `score` IS NULL;--> statement-breakpoint
CREATE TABLE `__new_performances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lo_id` integer NOT NULL,
	`study_date_id` integer NOT NULL,
	`score` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`lo_id`) REFERENCES `learning_objectives`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`study_date_id`) REFERENCES `study_dates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_performances`("id", "lo_id", "study_date_id", "score", "note", "created_at") SELECT "id", "lo_id", "study_date_id", "score", "note", "created_at" FROM `performances`;--> statement-breakpoint
DROP TABLE `performances`;--> statement-breakpoint
ALTER TABLE `__new_performances` RENAME TO `performances`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `performances_lo_date_unq` ON `performances` (`lo_id`,`study_date_id`);--> statement-breakpoint
ALTER TABLE `attempts` DROP COLUMN `rating`;