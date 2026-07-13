CREATE TABLE `ai_calls_monthly` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`model` text NOT NULL,
	`month` text NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_calls_monthly_uq` ON `ai_calls_monthly` (`account_id`,`model`,`month`);