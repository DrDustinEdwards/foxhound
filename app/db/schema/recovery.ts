import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool } from "./columns";
import { accounts, stripeConnections } from "./tenancy";

// ============================================================================
// Recovery core
// ============================================================================

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
    /** The card network's advice and raw decline code from the declined
     *  charge's outcome (migration 0049). The advice can override the decline
     *  category (recovery/decline.ts applyNetworkAdvice), and a stored
     *  "do_not_try_again" stops every silent retry (engine/retry-step.ts). */
    networkAdviceCode: text("network_advice_code"),
    networkDeclineCode: text("network_decline_code"),
    customerLtvCents: integer("customer_ltv_cents"),
    stripeProductId: text("stripe_product_id"),
    stripePriceId: text("stripe_price_id"),
    customerTimezone: text("customer_timezone"),
    deletedAt: ts("deleted_at"),
    processor: text("processor"),
    processorPaymentId: text("processor_payment_id"),
    processorCustomerId: text("processor_customer_id"),
    subscriptionStart: ts("subscription_start"),
    subscriptionId: text("subscription_id"),
    timeOfFailureHour: integer("time_of_failure_hour"),
    failureDayOfWeek: integer("failure_day_of_week"),
    priorFailureCount: integer("prior_failure_count"),
    isFirstFailureEver: bool("is_first_failure_ever"),
    merchantMrrRange: text("merchant_mrr_range"),
    merchantIndustry: text("merchant_industry"),
    planInterval: text("plan_interval"),
    amountTier: text("amount_tier"),
    abTestGroup: text("ab_test_group"),
    customerAgeDays: integer("customer_age_days"),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
    isRenewalNoise: bool("is_renewal_noise").notNull().default(false),
    /**
     * When a charge.refunded arrived for this payment (migration 0011). The
     * ORDER-INDEPENDENT half of refund handling: recovered_payments.refunded_at
     * can only be stamped once that row exists, so a refund that is processed
     * BEFORE invoice.payment_succeeded used to update zero rows, commit its
     * claim anyway, and be lost forever, leaving a refunded recovery fully
     * billable. This column is written on every refund regardless, and
     * buildRecoveryBatch reads it so a recovery recorded afterwards is born with
     * refunded_at already set. First refund wins, matching the recovered_payments
     * guard. See app/lib/recovery/record-recovery.ts.
     */
    refundSignalAt: ts("refund_signal_at"),
  },
  (t) => [
    index("failed_payments_account_idx").on(t.accountId),
    index("failed_payments_invoice_idx").on(t.stripeInvoiceId),
    // At most one ACTIVE failed_payment per invoice (one recovery sequence per
    // invoice; the invoice.payment_succeeded webhook flips it to 'recovered').
    // Makes intake dedupe structural; the read-guard in webhooks/process.ts stays
    // as a fast path, this is the backstop against a concurrent double-intake.
    uniqueIndex("failed_payments_active_invoice_uq")
      .on(t.stripeInvoiceId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const recoverySteps = sqliteTable(
  "recovery_steps",
  {
    id: id(),
    failedPaymentId: text("failed_payment_id").notNull().references(() => failedPayments.id),
    stepType: text("step_type").notNull(),
    stepNumber: integer("step_number"),
    scheduledAt: ts("scheduled_at").notNull(),
    executedAt: ts("executed_at"),
    result: text("result"),
    aiSubject: text("ai_subject"),
    aiBodyHtml: text("ai_body_html"),
    openedAt: ts("opened_at"),
    clickedAt: ts("clicked_at"),
    deletedAt: ts("deleted_at"),
    emailOpenedCount: integer("email_opened_count"),
    emailClickedCount: integer("email_clicked_count"),
    /** Why this step's click is not trusted as human engagement, or null when it
     *  is (ruling 377(4) phase one). Nullable text rather than a boolean so the
     *  ledger can say WHICH test the click failed. */
    clickSuspectReason: text("click_suspect_reason"),
    lastOpenedAt: ts("last_opened_at"),
    lastClickedAt: ts("last_clicked_at"),
    timeToOpenMinutes: integer("time_to_open_minutes"),
    emailSendHour: integer("email_send_hour"),
    emailSendDayOfWeek: integer("email_send_day_of_week"),
    retryResult: text("retry_result"),
    abVariant: text("ab_variant"),
    customBody: text("custom_body"),
    accountId: text("account_id").notNull().references(() => accounts.id),
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
    failedPaymentId: text("failed_payment_id").notNull().references(() => failedPayments.id),
    recoveredAt: ts("recovered_at").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    recoveryMethod: text("recovery_method").notNull(),
    recoveredByStepId: text("recovered_by_step_id").references(() => recoverySteps.id),
    deletedAt: ts("deleted_at"),
    recoveryStepType: text("recovery_step_type"),
    daysToRecover: integer("days_to_recover"),
    recoveryAttemptNumber: integer("recovery_attempt_number"),
    recoveryTrigger: text("recovery_trigger"),
    accountId: text("account_id").notNull().references(() => accounts.id),
    refundedAt: ts("refunded_at"),
    // Attribution spine (SCHEMA.md #1). CHECK enforces the four canon values.
    attributionKind: text("attribution_kind").notNull().default("stripe_baseline"),
    attributionRef: text("attribution_ref"),
    attributedAt: ts("attributed_at"),
    disputedAt: ts("disputed_at"),
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
    accountId: text("account_id").references(() => accounts.id),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
    deletedAt: ts("deleted_at"),
    // WHY THE ROW EXISTS (migration 0050). 'card_expiring' is every row the
    // nightly scan and customer.updated write. 'no_payment_method' is a
    // trialing customer with nothing to charge at conversion, recorded off
    // customer.subscription.trial_will_end; its card columns are NULL and its
    // expires_month/expires_year carry the TRIAL END month, which is when the
    // missing card will be needed, so the unique tuple below dedupes it per
    // trial-end month exactly as it dedupes a card per expiry month.
    reason: text("reason").$type<ExpiringCardAlertReason>().notNull().default("card_expiring"),
  },
  (t) => [
    index("expiring_card_alerts_account_idx").on(t.accountId),
    // ONE CANDIDATE PER CARD EXPIRY MONTH, enforced by the database (341
    // binding 3, and 314's "dedupe at the database").
    //
    // Legacy's webhook writer upserts `onConflict:
    // 'account_id,stripe_customer_id,expires_month,expires_year'`, which only
    // works against a unique index, so legacy has this and Foxhound did not.
    // Without it BOTH writers, the nightly scan and the customer.updated
    // webhook, race to insert the same tuple and the merchant's customer gets
    // two identical warnings.
    //
    // PLAIN, not partial on `deleted_at IS NULL`, because that is legacy's
    // shape: a soft-deleted alert therefore blocks a fresh candidate for the
    // same card and month, which is legacy's behavior and is recorded rather
    // than improved.
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
    accountId: text("account_id").references(() => accounts.id),
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
    winBackSequenceId: text("win_back_sequence_id").notNull().references(() => winBackSequences.id),
    stepNumber: integer("step_number").notNull(),
    scheduledAt: ts("scheduled_at").notNull(),
    executedAt: ts("executed_at"),
    result: text("result"),
    aiSubject: text("ai_subject"),
    aiBodyHtml: text("ai_body_html"),
    openedAt: ts("opened_at"),
    clickedAt: ts("clicked_at"),
    accountId: text("account_id").references(() => accounts.id),
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
