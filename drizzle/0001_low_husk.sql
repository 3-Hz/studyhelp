PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`stage` text NOT NULL,
	`lo_id` integer,
	`review_item_id` integer,
	`format` text NOT NULL,
	`question` text NOT NULL,
	`student_answer` text,
	`rating` text,
	`feedback` text,
	`hints_used` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lo_id`) REFERENCES `learning_objectives`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_item_id`) REFERENCES `review_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_attempts`("id", "session_id", "stage", "lo_id", "review_item_id", "format", "question", "student_answer", "rating", "feedback", "hints_used", "created_at") SELECT "id", "session_id", 'lo_recall', "lo_id", "review_item_id", "format", "question", "student_answer", "rating", "feedback", "hints_used", "created_at" FROM `attempts`;--> statement-breakpoint
DROP TABLE `attempts`;--> statement-breakpoint
ALTER TABLE `__new_attempts` RENAME TO `attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `attempts_session_idx` ON `attempts` (`session_id`);