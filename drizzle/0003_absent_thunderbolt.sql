CREATE TABLE `lecture_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lecture_id` integer NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`upload_index` integer NOT NULL,
	`storage_path` text,
	`byte_size` integer,
	`warnings` text,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`lecture_id`) REFERENCES `lectures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lecture_sources_lecture_idx` ON `lecture_sources` (`lecture_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lecture_sources_upload_idx` ON `lecture_sources` (`lecture_id`,`upload_index`);--> statement-breakpoint
DROP INDEX `lecture_assets_lecture_idx`;--> statement-breakpoint
ALTER TABLE `lecture_assets` ADD `source_id` integer REFERENCES lecture_sources(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `lecture_assets` ADD `global_ordinal` integer;--> statement-breakpoint
INSERT INTO `lecture_sources` (`lecture_id`, `kind`, `filename`, `upload_index`, `storage_path`)
SELECT `lecture_id`, `kind`, `filename`, `upload_index`, `storage_path` FROM (
	SELECT
		a.`lecture_id`                          AS `lecture_id`,
		a.`kind`                                AS `kind`,
		COALESCE(a.`filename`, 'unknown')       AS `filename`,
		MIN(a.`storage_path`)                   AS `storage_path`,
		ROW_NUMBER() OVER (
			PARTITION BY a.`lecture_id` ORDER BY MIN(a.`id`)
		)                                       AS `upload_index`
	FROM `lecture_assets` a
	GROUP BY a.`lecture_id`, a.`kind`, COALESCE(a.`filename`, 'unknown')
);--> statement-breakpoint
UPDATE `lecture_assets` SET `source_id` = (
	SELECT s.`id` FROM `lecture_sources` s
	WHERE s.`lecture_id` = `lecture_assets`.`lecture_id`
		AND s.`kind` = `lecture_assets`.`kind`
		AND s.`filename` = COALESCE(`lecture_assets`.`filename`, 'unknown')
);--> statement-breakpoint
UPDATE `lecture_assets` SET `global_ordinal` = (
	SELECT `rn` FROM (
		SELECT
			a.`id` AS `aid`,
			ROW_NUMBER() OVER (
				PARTITION BY a.`lecture_id` ORDER BY s.`upload_index`, a.`ordinal`
			) AS `rn`
		FROM `lecture_assets` a
		JOIN `lecture_sources` s ON s.`id` = a.`source_id`
		WHERE a.`kind` = 'slide'
	) WHERE `aid` = `lecture_assets`.`id`
) WHERE `kind` = 'slide';--> statement-breakpoint
UPDATE `lecture_assets` SET `ordinal` = 1 WHERE `kind` IN ('pdf', 'image');--> statement-breakpoint
CREATE UNIQUE INDEX `lecture_assets_source_ordinal` ON `lecture_assets` (`source_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `lecture_assets_lecture_idx` ON `lecture_assets` (`lecture_id`,`global_ordinal`);
