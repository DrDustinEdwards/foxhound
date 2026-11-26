-- contract: drops five single-column account_id indexes that the unique index starting with the same column already covers
-- (customer_context, early_fraud_warnings, expiring_card_alerts, intelligence_reports, mrr_snapshots), and replaces the
-- admin_api_calls delete trigger so the nightly retention sweep can delete rows older than 30 days (younger rows and every
-- update still abort). Adds a partial index on email_sends.win_back_step_id for the held win-back step's one blocked row.
-- No money table is touched. The deploy refuses a contract migration, so it is applied by hand after a D1 Time Travel bookmark.
DROP INDEX `early_fraud_warnings_account_idx`;--> statement-breakpoint
DROP INDEX `expiring_card_alerts_account_idx`;--> statement-breakpoint
DROP INDEX `customer_context_account_idx`;--> statement-breakpoint
DROP INDEX `intelligence_reports_account_idx`;--> statement-breakpoint
DROP INDEX `mrr_snapshots_account_idx`;--> statement-breakpoint
CREATE INDEX `email_sends_win_back_step_idx` ON `email_sends` (`win_back_step_id`) WHERE "email_sends"."win_back_step_id" is not null;--> statement-breakpoint
DROP TRIGGER `admin_api_calls_no_delete`;--> statement-breakpoint
CREATE TRIGGER `admin_api_calls_no_delete` BEFORE DELETE ON `admin_api_calls`
WHEN OLD.created_at > (CAST(strftime('%s', 'now') AS INTEGER) - 30 * 86400) * 1000
BEGIN
	SELECT RAISE(ABORT, 'admin_api_calls is append-only for 30 days');
END;
