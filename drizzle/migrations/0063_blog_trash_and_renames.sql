CREATE TABLE `blog_slug_redirects` (
	`from_slug` text PRIMARY KEY NOT NULL,
	`to_slug` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `blog_posts` ADD `trashed_at` integer;