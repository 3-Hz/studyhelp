ALTER TABLE `review_items` ADD `streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `outcomes` text;--> statement-breakpoint
UPDATE `review_items` SET `streak` = CASE
	WHEN `interval_days` >= 60 THEN 6
	WHEN `interval_days` >= 30 THEN 5
	WHEN `interval_days` >= 14 THEN 4
	WHEN `interval_days` >= 7 THEN 3
	WHEN `interval_days` >= 3 THEN 2
	WHEN `interval_days` >= 1 THEN 1
	ELSE 0
END
WHERE `last_rating` = 'green' AND `lapses` = 0;