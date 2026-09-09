ALTER TABLE `lecture_sources` ADD `role` text DEFAULT 'additional' NOT NULL;--> statement-breakpoint
ALTER TABLE `practice_questions` ADD `review_item_ids` text;--> statement-breakpoint
UPDATE `lecture_sources` SET `role` = CASE `kind` WHEN 'slide' THEN 'deck' WHEN 'transcript' THEN 'transcript' ELSE 'additional' END;