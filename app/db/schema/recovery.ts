import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool } from "./columns";
import { stripeConnections, accountRef } from "./tenancy";

export const failedPayments = sqliteTable(
  "failed_payments",
  {
    id: id(),
    stripeEventId: text("stripe_event_id").notNull(),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerName: text("customer_name"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    declineCode: text("decline_code"),
    declineCategory: text("decline_category").notNull(),
    planName: text("plan_name"),
    customerSince: ts("customer_since"),
    status: text("status").notNull(),
    detectedAt: ts("detected_at").notNull(),
    resolvedAt: ts("resolved_at"),
    notes: text("notes"),
    cardBrand: text("card_brand"),
    cardCountry: text("card_country"),
    cardFunding: text("card_funding"),
    /** The card network's advice and raw decline code from the declined charge's outcome. The advice can override the decline category (recovery/decline.ts applyNetworkAdvice), and a stored "do_not_try_again" stops every silent retry (engine/retry-step.ts). */
    networkAdviceCode: text("network_advice_code"),
    networkDeclineCode: text("network_decline_code"),
    deletedAt: ts("deleted_at"),
    processor: text("processor"),
    processorPaymentId: text("processor_payment_id"),
    processorCustomerId: text("processor_customer_id"),
    subscriptionStart: ts("subscription_start"),
    subscriptionId: text("subscription_id"),
    customerAgeDays: integer("customer_age_days"),
    accountId: accountRef(),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
    isRenewalNoise: bool("is_renewal_noise").notNull().default(false),
    /** When a charge.refunded arrived for this payment: the ORDER-INDEPENDENT half of refund handling. recovered_payments.refunded_at can only be stamped once that row exists, so a refund processed BEFORE invoice.payment_succeeded would update zero rows, commit its claim anyway, and be lost, leaving a refunded recovery fully billable. This column is written on every refund regardless, and buildRecoveryBatch reads it so a recovery recorded afterwards is born with refunded_at already set. First refund wins (app/lib/recovery/record-recovery.ts). */
    refundSignalAt: ts("refund_signal_at"),
    /** How much of the paying charge has been refunded, cumulative, as Stripe reports it (charge.amount_refunded), from the largest charge.refunded seen. The order-independent half of refunded_cents, read by buildRecoveryBatch like refund_signal_at, which is set only once the charge is FULLY refunded. */
    refundSignalCents: integer("refund_signal_cents"),
    /** When a dispute arrived for this payment's charge: the dispute twin of refund_signal_at. recovered_payments.disputed_at can only be stamped once that row exists, so dispute intake also writes this and buildRecoveryBatch reads it so a recovery recorded afterwards is born disputed. First dispute wins. */
    disputeSignalAt: ts("dispute_signal_at"),
  },
  (t) => [
    index("failed_payments_account_idx").on(t.accountId),
    index("failed_payments_invoice_idx").on(t.stripeInvoiceId),
    // At most one ACTIVE failed_payment per invoice (one recovery sequence per invoice; invoice.payment_succeeded flips it to 'recovered'). Makes intake dedupe structural; the read-guard in webhooks/process.ts is a fast path, this is the backstop against a concurrent double-intake.
    uniqueIndex("failed_payments_active_invoice_uq")
      .on(t.stripeInvoiceId)
      .where(sql`${t.status} = 'active'`),
  ],
);

/** The columns a recovery step and a win-back step share: when it runs and ran,
 *  its result, the AI-written mail and its first open and click. */
const sentStepColumns = () => ({
  scheduledAt: ts("scheduled_at").notNull(),
  executedAt: ts("executed_at"),
  result: text("result"),
  aiSubject: text("ai_subject"),
  aiBodyHtml: text("ai_body_html"),
  openedAt: ts("opened_at"),
  clickedAt: ts("clicked_at"),
});

export const recoverySteps = sqliteTable(
  "recovery_steps",
  {
    id: id(),
    failedPaymentId: text("failed_payment_id")
      .notNull()
      .references(() => failedPayments.id),
    stepType: text("step_type").notNull(),
    stepNumber: integer("step_number"),
    ...sentStepColumns(),
    deletedAt: ts("deleted_at"),
    emailOpenedCount: integer("email_opened_count"),
    emailClickedCount: integer("email_clicked_count"),
    /** Why this step's click is not trusted as human engagement, or null when it is. Text rather than a boolean so the ledger can say WHICH test the click failed. */
    clickSuspectReason: text("click_suspect_reason"),
    lastOpenedAt: ts("last_opened_at"),
    lastClickedAt: ts("last_clicked_at"),
    timeToOpenMinutes: integer("time_to_open_minutes"),
    emailSendHour: integer("email_send_hour"),
    emailSendDayOfWeek: integer("email_send_day_of_week"),
    retryResult: text("retry_result"),
    abVariant: text("ab_variant"),
    customBody: text("custom_body"),
    accountId: accountRef(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptError: text("last_attempt_error"),
    nextRetryAt: ts("next_retry_at"),
  },
  (t) => [
    index("recovery_steps_account_idx").on(t.accountId),
    index("recovery_steps_failed_payment_idx").on(t.failedPaymentId),
  ],
);

export const recoveredPayments = sqliteTable(
  "recovered_payments",
  {
    id: id(),
    failedPaymentId: text("failed_payment_id")
      .notNull()
      .references(() => failedPayments.id),
    recoveredAt: ts("recovered_at").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    recoveryMethod: text("recovery_method").notNull(),
    recoveredByStepId: text("recovered_by_step_id").references(() => recoverySteps.id),
    deletedAt: ts("deleted_at"),
    daysToRecover: integer("days_to_recover"),
    accountId: accountRef(),
    /** Set when the charge is FULLY refunded: no fee is owed at all. */
    refundedAt: ts("refunded_at"),
    /** How much of this recovery the merchant has refunded, cumulative. The fee is 20% of amount_cents minus this: a full refund means no fee. */
    refundedCents: integer("refunded_cents").notNull().default(0),
    // Attribution spine: CHECK enforces the four canon values.
    attributionKind: text("attribution_kind").notNull().default("stripe_baseline"),
    attributionRef: text("attribution_ref"),
    attributedAt: ts("attributed_at"),
    disputedAt: ts("disputed_at"),
    // What Stripe actually took, from the paying charge's balance transaction,
    // read best effort when the recovery is recorded. Null when the read failed
    // or has not happened. Display only: billing stays on amount_cents (gross).
    // net_currency is the balance transaction's (settlement) currency, which
    // can differ from `currency`.
    stripeBalanceTransactionId: text("stripe_balance_transaction_id"),
    stripeFeeCents: integer("stripe_fee_cents"),
    netAmountCents: integer("net_amount_cents"),
    netCurrency: text("net_currency"),
  },
  (t) => [
    index("recovered_payments_account_idx").on(t.accountId),
    index("recovered_payments_failed_payment_idx").on(t.failedPaymentId),
    check(
      "recovered_payments_attribution_kind_ck",
      sql`${t.attributionKind} in ('foxhound_retry', 'email_engaged', 'card_update', 'stripe_baseline', 'manual')`,
    ),
  ],
);

export type ExpiringCardAlertReason = "card_expiring" | "no_payment_method";

export const expiringCardAlerts = sqliteTable(
  "expiring_card_alerts",
  {
    id: id(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerName: text("customer_name"),
    cardLast4: text("card_last4"),
    cardBrand: text("card_brand"),
    expiresMonth: integer("expires_month").notNull(),
    expiresYear: integer("expires_year").notNull(),
    alertSentAt: ts("alert_sent_at"),
    createdAt: ts("created_at").notNull(),
    accountId: accountRef(),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
    deletedAt: ts("deleted_at"),
    // 'card_expiring' is every row the nightly scan and customer.updated write. 'no_payment_method' is a trialing customer with nothing to charge at conversion, recorded off customer.subscription.trial_will_end; its card columns are NULL and expires_month/expires_year carry the TRIAL END month, so the unique tuple below dedupes it per trial-end month as it dedupes a card per expiry month.
    reason: text("reason").$type<ExpiringCardAlertReason>().notNull().default("card_expiring"),
  },
  (t) => [
    // ONE CANDIDATE PER CARD EXPIRY MONTH, enforced by the database: the nightly scan and the customer.updated webhook would otherwise race to insert the same tuple and the merchant's customer would get two identical warnings. The webhook writer upserts against this unique index. PLAIN, not partial on `deleted_at IS NULL`, so a soft-deleted alert blocks a fresh candidate for the same card and month.
    uniqueIndex("expiring_card_alerts_card_month_uq").on(
      t.accountId,
      t.stripeCustomerId,
      t.expiresMonth,
      t.expiresYear,
    ),
  ],
);

export const winBackSequences = sqliteTable(
  "win_back_sequences",
  {
    id: id(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerName: text("customer_name"),
    planName: text("plan_name"),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    cancelReason: text("cancel_reason"),
    status: text("status").notNull(),
    createdAt: ts("created_at").notNull(),
    resolvedAt: ts("resolved_at"),
    reactivatedAt: ts("reactivated_at"),
    reactivatedByStepId: text("reactivated_by_step_id"),
    accountId: accountRef(),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
  },
  (t) => [
    index("win_back_sequences_account_idx").on(t.accountId),
    uniqueIndex("win_back_sequences_subscription_uq").on(t.stripeSubscriptionId),
  ],
);

export const winBackSteps = sqliteTable(
  "win_back_steps",
  {
    id: id(),
    winBackSequenceId: text("win_back_sequence_id")
      .notNull()
      .references(() => winBackSequences.id),
    stepNumber: integer("step_number").notNull(),
    ...sentStepColumns(),
    accountId: accountRef(),
    deletedAt: ts("deleted_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptError: text("last_attempt_error"),
    nextRetryAt: ts("next_retry_at"),
  },
  (t) => [
    index("win_back_steps_sequence_idx").on(t.winBackSequenceId),
    index("win_back_steps_account_idx").on(t.accountId),
  ],
);
