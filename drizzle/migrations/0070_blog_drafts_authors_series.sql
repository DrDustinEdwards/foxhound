CREATE TABLE `blog_post_drafts` (
	`post_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`change_id` text NOT NULL,
	`saved_at` integer NOT NULL,
	`saved_by` text,
	FOREIGN KEY (`post_id`) REFERENCES `blog_posts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `blog_post_links_removed` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`source_slug` text,
	`target_slug` text,
	`source_title` text,
	`target_title` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`removed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `blog_post_links_removed_target_idx` ON `blog_post_links_removed` (`target_id`);--> statement-breakpoint
ALTER TABLE `blog_post_versions` ADD `source` text;--> statement-breakpoint
ALTER TABLE `blog_post_versions` ADD `message` text;--> statement-breakpoint
ALTER TABLE `blog_posts` ADD `authors` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `blog_posts` ADD `series` text;--> statement-breakpoint
ALTER TABLE `blog_posts` ADD `series_part` integer;--> statement-breakpoint
-- Every post had one author in `author`; it becomes the first (and only) name in `authors`.
UPDATE `blog_posts` SET `authors` = json_array(`author`) WHERE trim(`author`) <> '';