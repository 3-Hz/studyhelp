CREATE TABLE `concept_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`review_item_id` integer NOT NULL,
	`study_date_id` integer NOT NULL,
	`mark` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`review_item_id`) REFERENCES `review_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`study_date_id`) REFERENCES `study_dates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `concept_marks_item_idx` ON `concept_marks` (`review_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `concept_marks_item_date_unq` ON `concept_marks` (`review_item_id`,`study_date_id`);--> statement-breakpoint
CREATE TABLE `practice_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lecture_id` integer NOT NULL,
	`lo_id` integer,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`slide_refs` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`lecture_id`) REFERENCES `lectures`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lo_id`) REFERENCES `learning_objectives`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `practice_questions_lecture_idx` ON `practice_questions` (`lecture_id`);--> statement-breakpoint
ALTER TABLE `attempts` ADD `score` integer;--> statement-breakpoint
ALTER TABLE `attempts` ADD `concept_marks` text;--> statement-breakpoint
ALTER TABLE `performances` ADD `score` integer;--> statement-breakpoint
ALTER TABLE `review_items` ADD `ordinal` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `minutes` integer;--> statement-breakpoint
UPDATE `review_items` SET `ordinal` = (
	SELECT COUNT(*) FROM `review_items` AS `earlier`
	WHERE `earlier`.`lo_id` = `review_items`.`lo_id` AND `earlier`.`id` <= `review_items`.`id`
);--> statement-breakpoint
UPDATE `performances` SET `score` = CASE `rating`
	WHEN 'green' THEN 5
	WHEN 'yellow' THEN 4
	WHEN 'red' THEN 2
END;--> statement-breakpoint
UPDATE `attempts` SET `score` = CASE `rating`
	WHEN 'green' THEN 5
	WHEN 'yellow' THEN 4
	WHEN 'red' THEN 2
END
WHERE `rating` IS NOT NULL;