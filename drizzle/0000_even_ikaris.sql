CREATE TABLE `attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`lo_id` integer NOT NULL,
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
CREATE INDEX `attempts_session_idx` ON `attempts` (`session_id`);--> statement-breakpoint
CREATE TABLE `learning_objectives` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lecture_id` integer NOT NULL,
	`text` text NOT NULL,
	`order_index` integer NOT NULL,
	`suspended` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`lecture_id`) REFERENCES `lectures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `los_lecture_idx` ON `learning_objectives` (`lecture_id`,`order_index`);--> statement-breakpoint
CREATE TABLE `lecture_assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lecture_id` integer NOT NULL,
	`kind` text NOT NULL,
	`ordinal` integer NOT NULL,
	`filename` text,
	`slide_text` text,
	`notes_text` text,
	`storage_path` text,
	FOREIGN KEY (`lecture_id`) REFERENCES `lectures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lecture_assets_lecture_idx` ON `lecture_assets` (`lecture_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `lectures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`block` text,
	`draft_extract` text,
	`extraction_meta` text,
	`extraction_warnings` text,
	`extracted_at` integer,
	`committed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_session_idx` ON `messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `performances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lo_id` integer NOT NULL,
	`study_date_id` integer NOT NULL,
	`rating` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`lo_id`) REFERENCES `learning_objectives`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`study_date_id`) REFERENCES `study_dates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `performances_lo_date_unq` ON `performances` (`lo_id`,`study_date_id`);--> statement-breakpoint
CREATE TABLE `review_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lo_id` integer NOT NULL,
	`concept` text NOT NULL,
	`kind` text NOT NULL,
	`provenance` text DEFAULT 'taught' NOT NULL,
	`due_on` text NOT NULL,
	`interval_days` integer DEFAULT 0 NOT NULL,
	`last_rating` text,
	`lapses` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`lo_id`) REFERENCES `learning_objectives`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_items_due_idx` ON `review_items` (`due_on`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`lecture_id` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`lecture_id`) REFERENCES `lectures`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `study_dates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `study_dates_date_unique` ON `study_dates` (`date`);