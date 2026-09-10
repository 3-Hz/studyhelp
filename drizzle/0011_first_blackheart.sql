ALTER TABLE `review_items` ADD `label` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `review_items` ADD `emphasis` text DEFAULT 'neutral' NOT NULL;--> statement-breakpoint
ALTER TABLE `review_items` ADD `emphasis_cue` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `review_items` SET `label` = CASE WHEN instr(`concept`, ' — ') > 0 THEN substr(`concept`, 1, instr(`concept`, ' — ') - 1) ELSE `concept` END WHERE `label` = '';
