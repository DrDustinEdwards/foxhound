/**
 * Queue consumer retry ceiling before dead-letter (mirrors the wrangler
 * consumer config).
 */
export const EMAIL_QUEUE_MAX_RETRIES = 3;
/** Queue names. */
export const EMAIL_QUEUE_NAME = "foxhound-email";
/** The dead-letter queue for EMAIL_QUEUE_NAME (the consumer's `dead_letter_queue` in wrangler.jsonc). */
export const EMAIL_DLQ_QUEUE_NAME = "foxhound-email-dlq";
export const EMAIL_EVENTS_QUEUE_NAME = "foxhound-email-events";
/**
 * The monthly audit queue: the cron sends one message per opted-in account, so
 * each account's Stripe pages are spent inside its own invocation's subrequest
 * budget.
 */
export const AUDIT_QUEUE_NAME = "foxhound-audit";
/**
 * Mirrors max_retries on the foxhound-audit consumer in wrangler.jsonc; the
 * delivery whose attempts exceed this is the last one and raises the alert.
 */
export const AUDIT_QUEUE_MAX_RETRIES = 3;
/** Cloudflare Queues accepts at most 100 messages per sendBatch call. */
export const AUDIT_QUEUE_SEND_BATCH_MAX = 100;
