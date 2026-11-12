import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts } from "./columns";
import { recoverySteps, winBackSteps } from "./recovery";
import { optionalAccountRef } from "./tenancy";

// ============================================================================
// Email dispatch and first-party engagement (redesigned off Email Service)
// ============================================================================

export const emailSends = sqliteTable(
  "email_sends",
  {
    id: id(),
    accountId: optionalAccountRef(),
    recoveryStepId: text("recovery_step_id").references(() => recoverySteps.id),
    winBackStepId: text("win_back_step_id").references(() => winBackSteps.id),
    queueMessageId: text("queue_message_id"),
    template: text("template"),
    recipientHash: text("recipient_hash"),
    status: text("status").notNull(),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    sentAt: ts("sent_at"),
    /** The cron run that produced this send. Ruling 311 measured that a
     *  send could not be attributed to its run, so "which run sent this" meant
     *  correlating timestamps. This is the run's id (cronRunId in
     *  app/lib/admin/crons.ts: its job and start, the key of its cron_run_log
     *  row).
     *
     *  NULLABLE, and deliberately NOT a foreign key: email_sends is kept 180
     *  days (RETENTION_EMAIL_SENDS_DAYS) and cron_run_log 90
     *  (RETENTION_CRON_LOG_DAYS), so a send legitimately outlives its run. This
     *  column records provenance; it is not a live relation. */
    cronRunId: text("cron_run_id"),
    /** THE SEND CLAIM. `EmailJob.idempotencyKey` existed from the start and
     *  was read by NOTHING, which 376 item 15 recorded: the type promised a
     *  dedupe the code never performed. This column is its first reader.
     *
     *  The row is written BEFORE the provider call with status `pending`, so a
     *  worker killed between the send and the log leaves the claim behind and
     *  the retry finds it instead of sending again. That is the residual 385
     *  left open when it ruled the step-level send-then-claim order stays.
     *
     *  NULLABLE, and the index is partial, because only CLAIMED sends carry a
     *  key. Suppressed and blocked rows are logged with a null key deliberately:
     *  a blocked row is the live-send flag refusing, and if it held the key then
     *  switching the merchant on would find the claim and skip the send forever. */
    idempotencyKey: text("idempotency_key"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("email_sends_account_idx").on(t.accountId),
    // Retention sweep predicate (cron/retention.ts); without it every daily sweep reads the whole table.
    index("email_sends_created_idx").on(t.createdAt),
    uniqueIndex("email_sends_idempotency_uq")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

/** Dead-lettered dunning emails. Until this table the queue's
 *  `dead_letter_queue` was a bare NAME with no consumer, and wrangler.jsonc's own
 *  comment recorded the consequence: "a dunning email that keeps failing is
 *  discarded with no trace after max_retries". This is the trace. Writing the row
 *  is the whole job; retry-from-DLQ is deliberately NOT built here.
 *
 *  Carries a recipientHash rather than an address, matching email_sends' privacy
 *  shape: a dead letter is a diagnostic, not a mailbox. */
export const emailDeadLetters = sqliteTable(
  "email_dead_letters",
  {
    id: id(),
    accountId: text("account_id"),
    recoveryStepId: text("recovery_step_id"),
    winBackStepId: text("win_back_step_id"),
    queueMessageId: text("queue_message_id"),
    template: text("template"),
    recipientHash: text("recipient_hash"),
    /** Delivery attempts the queue made before giving up. */
    attempts: integer("attempts"),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("email_dead_letters_account_idx").on(t.accountId)],
);

// site-runtime ./cron-alert's ALERTS_SQL, written and read only by alertOnce and cronAlert.
export { alertsSent } from "@dustinedwards/site-runtime/drizzle";

export const engagementEvents = sqliteTable(
  "engagement_events",
  {
    id: id(),
    accountId: optionalAccountRef(),
    emailSendId: text("email_send_id").references(() => emailSends.id),
    recoveryStepId: text("recovery_step_id").references(() => recoverySteps.id),
    // click is the billable engagement standard; open feeds Intelligence only (PRICING.md)
    eventType: text("event_type").notNull(),
    // idempotency: one row per first-party hit event
    idempotencyKey: text("idempotency_key").notNull(),
    targetUrl: text("target_url"),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("engagement_events_account_idx").on(t.accountId),
    // Retention sweep predicate (cron/retention.ts); without it every daily sweep reads the whole table.
    index("engagement_events_occurred_idx").on(t.occurredAt),
    uniqueIndex("engagement_events_idempotency_uq").on(t.idempotencyKey),
    check("engagement_events_type_ck", sql`${t.eventType} in ('open', 'click')`),
  ],
);

export const emailSuppressions = sqliteTable(
  "email_suppressions",
  {
    id: id(),
    email: text("email").notNull(),
    token: text("token").notNull(),
    suppressedAt: ts("suppressed_at"),
    accountId: optionalAccountRef(),
    reason: text("reason"),
  },
  (t) => [
    index("email_suppressions_account_idx").on(t.accountId),
    // Suppression is one row per address (hard bounce / complaint / opt-out kills
    // the address platform-wide). Structural idempotency for the bounce consumer:
    // a redelivered event collapses via onConflictDoNothing on this unique index.
    uniqueIndex("email_suppressions_email_uq").on(t.email),
  ],
);
