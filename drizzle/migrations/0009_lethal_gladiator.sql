ALTER TABLE `blog_posts` ADD `reading_minutes` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `blog_posts_published_published_at_idx` ON `blog_posts` (`published`,`published_at`);