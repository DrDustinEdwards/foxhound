ALTER TABLE `blog_posts` ADD `og_image_url` text;--> statement-breakpoint
ALTER TABLE `blog_posts` ADD `og_image_alt` text;--> statement-breakpoint
ALTER TABLE `blog_posts` ADD `noindex` integer DEFAULT false NOT NULL;