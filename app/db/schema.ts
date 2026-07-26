// Foxhound D1 schema (Drizzle, SQLite dialect).
//
// Design governed by docs/canon/SCHEMA.md; column truth cross-checked against the
// legacy database schema (docs/schema/legacy-map.md). Conventions:
//   - ids: text (uuid string), app-generated via crypto.randomUUID()
//   - timestamps: integer epoch ms (mode: 'timestamp_ms' -> Date in TS)
//   - booleans: integer 0/1 (mode: 'boolean')
//   - json / arrays: text (mode: 'json')
//   - money: integer cents, always paired with a currency column in the same row
//   - enums (canon-defined only): CHECK constraints; legacy-valued text columns are
//     left as plain text (their value sets were not probed) per legacy-map.md.
// Every tenant table carries account_id + an index. Better Auth owns user/session/
// account(singular)/verification (Phase 3); user_id columns here are soft references
// (no enforced FK yet) per legacy-map.md.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ---- shared column helpers ----
const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const bool = (name: string) => integer(name, { mode: "boolean" });
function json<T = unknown>(name: string) {
  return text(name, { mode: "json" }).$type<T>();
}

// ============================================================================
// Tenancy and identity (business-owned; Better Auth owns user/session/etc.)
// ============================================================================

export const accounts = sqliteTable("accounts", {
  id: id(),
  name: text("name"),
  notificationEmail: text("notification_email"),
  slackWebhookUrl: text("slack_webhook_url"),
  digestEnabled: bool("digest_enabled"),
  recoveryNotificationsEnabled: bool("recovery_notifications_enabled"),
  sequenceCompleteNotificationsEnabled: bool("sequence_complete_notifications_enabled"),
  winbackNotificationsEnabled: bool("winback_notifications_enabled"),
  expiringCardNotificationsEnabled: bool("expiring_card_notifications_enabled"),
  onboardingCompleted: bool("onboarding_completed"),
  createdAt: ts("created_at"),
  mrrEstimateCents: integer("mrr_estimate_cents"),
  // merchant home currency for mrr_estimate_cents / merchant_mrr_self_reported
  currency: text("currency"),
  merchantIndustry: text("merchant_industry"),
  primaryCustomerType: text("primary_customer_type"),
  merchantMrrSelfReported: integer("merchant_mrr_self_reported"),
  slackNotificationsEnabled: bool("slack_notifications_enabled"),
  digestEmail: text("digest_email"),
  lastVisitedPath: text("last_visited_path"),
  lastVisitedProduct: text("last_visited_product"),
  billingExempt: bool("billing_exempt").notNull().default(false),
  processingPaused: bool("processing_paused").notNull().default(false),
  // Operator-initiated cancel/disconnect (admin Pass 2). Distinct from
  // processingPaused on purpose: this is a PROCESSING gate only (recovery-tick,
  // intelligence-sync), never a billing gate. Already-matured, unbilled
  // recoveries/disputes must still bill after cancel unless the account is
  // ALSO billing_exempt (PRICING.md: cancel never silently forgives owed fees).
  // app/db/billable.ts's accountBillingEligibleCondition deliberately does not
  // reference this column.
  cancelledAt: ts("cancelled_at"),
  // Foxhound's OWN Stripe account customer id for this merchant (PRICING.md rev 3:
  // direct platform invoicing, not Connect application fees). Null until
  // billing-setup runs; createPlatformInvoice refuses to charge without it.
  platformStripeCustomerId: text("platform_stripe_customer_id"),
  disputeProductDescription: text("dispute_product_description"),
  disputeShipsPhysical: bool("dispute_ships_physical"),
  disputeAutoSubmit: bool("dispute_auto_submit"),
  auditLookbackDays: integer("audit_lookback_days"),
  auditAutoRun: bool("audit_auto_run"),
  theme: text("theme").notNull().default("dark"),
});

export const accountMembers = sqliteTable(
  "account_members",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    // soft ref to Better Auth user.id (Phase 3); no enforced FK yet
    userId: text("user_id"),
    role: text("role").notNull(),
    invitedEmail: text("invited_email"),
    status: text("status").notNull(),
    inviteToken: text("invite_token"),
    inviteExpiresAt: ts("invite_expires_at"),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("account_members_account_idx").on(t.accountId),
    // At most one ACTIVE membership per user (the single-account invariant).
    // Pending invite rows carry a null user_id and status 'pending', so they are
    // excluded. Makes the invariant database-enforced; the read-check in
    // acceptInvite stays as a fast path, this is the backstop against a
    // concurrent double-accept landing two active memberships.
    uniqueIndex("account_members_one_active_per_user_uq")
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const stripeConnections = sqliteTable(
  "stripe_connections",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeUserId: text("stripe_user_id").notNull(),
    // encrypted at rest by app code; never logged (ARCHITECTURE.md non-negotiable #5)
    stripeAccessToken: text("stripe_access_token"),
    stripePublishableKey: text("stripe_publishable_key"),
    stripeScope: text("stripe_scope"),
    name: text("name"),
    isPrimary: bool("is_primary").notNull().default(false),
    connectedAt: ts("connected_at"),
    disconnectedAt: ts("disconnected_at"),
    lastWebhookAt: ts("last_webhook_at"),
    webhookEndpointId: text("webhook_endpoint_id"),
    createdAt: ts("created_at").notNull(),
    senderName: text("sender_name"),
    senderDomain: text("sender_domain"),
    replyToEmail: text("reply_to_email"),
    brandVoice: text("brand_voice"),
    brandVoiceSoft: text("brand_voice_soft"),
    brandVoiceExpired: text("brand_voice_expired"),
    brandVoiceNetwork: text("brand_voice_network"),
    brandVoiceFraud: text("brand_voice_fraud"),
  },
  (t) => [index("stripe_connections_account_idx").on(t.accountId)],
);

export const accountProducts = sqliteTable(
  "account_products",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    product: text("product").notNull(),
    status: text("status").notNull(),
    stripeSubscriptionItemId: text("stripe_subscription_item_id"),
    activatedAt: ts("activated_at"),
    cancelledAt: ts("cancelled_at"),
    trialEndsAt: ts("trial_ends_at"),
    createdAt: ts("created_at"),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
  },
  (t) => [index("account_products_account_idx").on(t.accountId)],
);

export const accountSubscriptions = sqliteTable(
  "account_subscriptions",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    product: text("product").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    status: text("status").notNull(),
    billingInterval: text("billing_interval"),
    currentPeriodEndsAt: ts("current_period_ends_at"),
    trialEndsAt: ts("trial_ends_at"),
    createdAt: ts("created_at").notNull(),
    canceledAt: ts("canceled_at"),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
    cancellationReason: text("cancellation_reason"),
    cancellationFeedback: text("cancellation_feedback"),
    // admin_granted rows never touch Stripe APIs (PRICING.md / SCHEMA.md)
    adminGranted: bool("admin_granted").notNull().default(false),
  },
  (t) => [index("account_subscriptions_account_idx").on(t.accountId)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: id(),
    accountId: text("account_id").references(() => accounts.id),
    keyHash: text("key_hash").notNull(),
    label: text("label"),
    scope: text("scope").notNull(),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_keys_account_idx").on(t.accountId)],
);

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
      sql`${t.attributionKind} in ('foxhound_retry', 'email_engaged', 'card_update', 'stripe_baseline')`,
    ),
  ],
);

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
  },
  (t) => [index("expiring_card_alerts_account_idx").on(t.accountId)],
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

// ============================================================================
// Email dispatch and first-party engagement (redesigned off Email Service)
// ============================================================================

export const emailSends = sqliteTable(
  "email_sends",
  {
    id: id(),
    accountId: text("account_id").references(() => accounts.id),
    recoveryStepId: text("recovery_step_id").references(() => recoverySteps.id),
    winBackStepId: text("win_back_step_id").references(() => winBackSteps.id),
    queueMessageId: text("queue_message_id"),
    template: text("template"),
    recipientHash: text("recipient_hash"),
    status: text("status").notNull(),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    sentAt: ts("sent_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("email_sends_account_idx").on(t.accountId)],
);

export const engagementEvents = sqliteTable(
  "engagement_events",
  {
    id: id(),
    accountId: text("account_id").references(() => accounts.id),
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
    uniqueIndex("engagement_events_idempotency_uq").on(t.idempotencyKey),
    check(
      "engagement_events_type_ck",
      sql`${t.eventType} in ('open', 'click')`,
    ),
  ],
);

export const emailSuppressions = sqliteTable(
  "email_suppressions",
  {
    id: id(),
    email: text("email").notNull(),
    token: text("token").notNull(),
    suppressedAt: ts("suppressed_at"),
    accountId: text("account_id").references(() => accounts.id),
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

// ============================================================================
// Billing (rebuilt per PRICING.md: invoices + line items, no orphan charges)
// ============================================================================

export const billingInvoices = sqliteTable(
  "billing_invoices",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    currency: text("currency").notNull(),
    periodStart: ts("period_start").notNull(),
    periodEnd: ts("period_end").notNull(),
    status: text("status").notNull().default("draft"),
    totalCents: integer("total_cents").notNull().default(0),
    stripeInvoiceId: text("stripe_invoice_id"),
    stripeInvoiceUrl: text("stripe_invoice_url"),
    // two-layer idempotency (SCHEMA.md billing): unique per account/currency/period run
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: ts("created_at").notNull(),
    finalizedAt: ts("finalized_at"),
    // Charge-dispatch retry bookkeeping (app/lib/billing/fee-retry.ts, migration
    // 0010). The ported state machine caps how many times Foxhound chases one
    // fee invoice, and nothing already in the schema could derive an attempt
    // count: the row is written once and the Stripe charge seam is stateless.
    chargeAttemptCount: integer("charge_attempt_count").notNull().default(0),
    lastChargeAttemptAt: ts("last_charge_attempt_at"),
  },
  (t) => [
    index("billing_invoices_account_idx").on(t.accountId),
    uniqueIndex("billing_invoices_idempotency_uq").on(t.idempotencyKey),
  ],
);

export const billingLineItems = sqliteTable(
  "billing_line_items",
  {
    id: id(),
    invoiceId: text("invoice_id").notNull().references(() => billingInvoices.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    // recovery_fee | dispute_fee | subscription | adjustment (PRICING.md)
    type: text("type").notNull(),
    currency: text("currency").notNull(),
    // signed for adjustment; otherwise the billed amount in cents
    amountCents: integer("amount_cents").notNull(),
    feeCents: integer("fee_cents"),
    // evidence FKs: exactly one set for recovery_fee / dispute_fee
    recoveredPaymentId: text("recovered_payment_id").references(() => recoveredPayments.id),
    disputeId: text("dispute_id").references(() => disputes.id),
    // adjustment requires an admin_audit_log entry; DB-enforced below (admin Pass 2)
    adminAuditLogId: text("admin_audit_log_id").references(() => adminAuditLog.id),
    description: text("description"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("billing_line_items_invoice_idx").on(t.invoiceId),
    index("billing_line_items_account_idx").on(t.accountId),
    // structural no-double-billing: one line item per recovery, one per dispute
    uniqueIndex("billing_line_items_recovery_uq")
      .on(t.recoveredPaymentId)
      .where(sql`${t.recoveredPaymentId} is not null`),
    uniqueIndex("billing_line_items_dispute_uq")
      .on(t.disputeId)
      .where(sql`${t.disputeId} is not null`),
    check(
      "billing_line_items_type_ck",
      sql`${t.type} in ('recovery_fee', 'dispute_fee', 'subscription', 'adjustment')`,
    ),
    // I3 (Phase 5 review, closed admin Pass 2): an adjustment line item is
    // never valid without its admin_audit_log entry. DB-enforced, not just
    // app-enforced; recovery_fee/dispute_fee/subscription rows are unaffected
    // (their admin_audit_log_id stays null).
    check(
      "billing_line_items_adjustment_audit_ck",
      sql`${t.type} != 'adjustment' or ${t.adminAuditLogId} is not null`,
    ),
  ],
);

// ============================================================================
// Disputes (rebuilt as a state machine with an approval gate)
// ============================================================================

export const disputes = sqliteTable(
  "disputes",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeDisputeId: text("stripe_dispute_id").notNull(),
    stripeChargeId: text("stripe_charge_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    customerEmail: text("customer_email"),
    customerName: text("customer_name"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    reason: text("reason").notNull(),
    // legacy provenance columns (unprobed value sets -> plain text, no CHECK)
    status: text("status").notNull(),
    outcome: text("outcome"),
    outcomeAmountCents: integer("outcome_amount_cents"),
    evidenceDeadline: ts("evidence_deadline"),
    aiResponseText: text("ai_response_text"),
    aiGeneratedAt: ts("ai_generated_at"),
    submittedAt: ts("submitted_at"),
    createdAt: ts("created_at").notNull(),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
    resolvedAt: ts("resolved_at"),
    customerId: text("customer_id"),
    customerIp: text("customer_ip"),
    billingAddress: text("billing_address"),
    avsResult: text("avs_result"),
    cvvResult: text("cvv_result"),
    radarRiskScore: integer("radar_risk_score"),
    radarRiskLevel: text("radar_risk_level"),
    threeDSecure: text("three_d_secure"),
    priorChargesCount: integer("prior_charges_count"),
    priorChargesTotal: integer("prior_charges_total"),
    priorChargesJson: json("prior_charges_json"),
    subscriptionJson: json("subscription_json"),
    recoveryEmailsJson: json("recovery_emails_json"),
    smartDisputesStatus: text("smart_disputes_status"),
    structuredEvidenceJson: json("structured_evidence_json"),
    triageRecommendation: text("triage_recommendation"),
    triageConfidence: integer("triage_confidence"),
    triageReasoning: text("triage_reasoning"),
    submittedBy: text("submitted_by"),
    stagedAt: ts("staged_at"),
    outcomeNotifiedAt: ts("outcome_notified_at"),
    shippingTrackingNumber: text("shipping_tracking_number"),
    shippingCarrier: text("shipping_carrier"),
    shippingDate: ts("shipping_date"),
    // Foxhound state machine + resolved fee snapshot (SCHEMA.md).
    state: text("state").notNull().default("draft"),
    resolvedFeeCents: integer("resolved_fee_cents"),
    resolvedFeeCurrency: text("resolved_fee_currency"),
  },
  (t) => [
    index("disputes_account_idx").on(t.accountId),
    uniqueIndex("disputes_stripe_dispute_uq").on(t.stripeDisputeId),
    check(
      "disputes_state_ck",
      sql`${t.state} in ('draft', 'pending_review', 'approved', 'submitted', 'resolved_won', 'resolved_lost')`,
    ),
  ],
);

export const disputeEvidence = sqliteTable(
  "dispute_evidence",
  {
    id: id(),
    disputeId: text("dispute_id").notNull().references(() => disputes.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    fieldName: text("field_name").notNull(),
    fieldValue: text("field_value").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    index("dispute_evidence_account_idx").on(t.accountId),
    index("dispute_evidence_dispute_idx").on(t.disputeId),
  ],
);

export const disputeApprovals = sqliteTable(
  "dispute_approvals",
  {
    id: id(),
    disputeId: text("dispute_id").notNull().references(() => disputes.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    // soft ref to Better Auth user.id (Phase 3)
    approvedByUserId: text("approved_by_user_id"),
    approvedByEmail: text("approved_by_email"),
    // hash of the evidence version approved (submission requires this row)
    evidenceVersionHash: text("evidence_version_hash").notNull(),
    approvedAt: ts("approved_at").notNull(),
  },
  (t) => [
    index("dispute_approvals_account_idx").on(t.accountId),
    uniqueIndex("dispute_approvals_dispute_uq").on(t.disputeId),
  ],
);

// ============================================================================
// Intelligence
// ============================================================================

export const customerContext = sqliteTable(
  "customer_context",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    customerEmail: text("customer_email"),
    customerName: text("customer_name"),
    customerSince: ts("customer_since"),
    lastSeenAt: ts("last_seen_at"),
    mrrContributionCents: integer("mrr_contribution_cents"),
    ltvCents: integer("ltv_cents"),
    // currency for mrr_contribution_cents / ltv_cents
    currency: text("currency"),
    activeSubscriptionsCount: integer("active_subscriptions_count"),
    currentPlanName: text("current_plan_name"),
    currentPlanTier: text("current_plan_tier"),
    recoverySignals: json("recovery_signals"),
    disputeSignals: json("dispute_signals"),
    engagementSignals: json("engagement_signals"),
    healthScore: integer("health_score"),
    healthScoreCalculatedAt: ts("health_score_calculated_at"),
    healthFactors: json("health_factors"),
    aiAssessment: text("ai_assessment"),
    aiAssessmentGeneratedAt: ts("ai_assessment_generated_at"),
    aiRecommendedActions: json("ai_recommended_actions"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    // Structured billing-behavior signals (SCHEMA.md; names are Phase-2 judgment,
    // Phase 4 owns population). Nullable so every customer row can exist pre-scoring.
    subscriptionAgeDays: integer("subscription_age_days"),
    planChangeCount: integer("plan_change_count"),
    seatChangeCount: integer("seat_change_count"),
    intervalSwitchCount: integer("interval_switch_count"),
    paymentLatencyDriftDays: integer("payment_latency_drift_days"),
    refundCount: integer("refund_count"),
    disputeCount: integer("dispute_count"),
  },
  (t) => [
    index("customer_context_account_idx").on(t.accountId),
    uniqueIndex("customer_context_account_customer_uq").on(t.accountId, t.stripeCustomerId),
  ],
);

export const healthScoreHistory = sqliteTable(
  "health_score_history",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    customerContextId: text("customer_context_id").notNull().references(() => customerContext.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    recordedAt: ts("recorded_at").notNull(),
    healthScore: integer("health_score").notNull(),
    healthFactors: json("health_factors").notNull(),
    scoreSource: text("score_source").notNull(),
  },
  (t) => [
    index("health_score_history_account_idx").on(t.accountId),
    index("health_score_history_customer_idx").on(t.customerContextId),
  ],
);

export const predictions = sqliteTable(
  "predictions",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    score: integer("score").notNull(),
    // hash of the evidence bands that produced the score
    bandEvidenceHash: text("band_evidence_hash"),
    horizonDays: integer("horizon_days").notNull(),
    predictedAt: ts("predicted_at").notNull(),
    // realized-outcome slot for backtesting (nullable until graded)
    realizedOutcome: text("realized_outcome"),
    gradedAt: ts("graded_at"),
  },
  (t) => [
    index("predictions_account_idx").on(t.accountId),
    index("predictions_customer_idx").on(t.stripeCustomerId),
  ],
);

export const mrrSnapshots = sqliteTable(
  "mrr_snapshots",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    snapshotDate: ts("snapshot_date").notNull(),
    totalMrrCents: integer("total_mrr_cents").notNull(),
    newMrrCents: integer("new_mrr_cents").notNull(),
    expansionMrrCents: integer("expansion_mrr_cents").notNull(),
    contractionMrrCents: integer("contraction_mrr_cents").notNull(),
    churnMrrCents: integer("churn_mrr_cents").notNull(),
    reactivationMrrCents: integer("reactivation_mrr_cents").notNull(),
    activeCustomersCount: integer("active_customers_count").notNull(),
    newCustomersCount: integer("new_customers_count").notNull(),
    churnedCustomersCount: integer("churned_customers_count").notNull(),
    perPlanBreakdown: json("per_plan_breakdown").notNull(),
    perCohortBreakdown: json("per_cohort_breakdown").notNull(),
    perChannelBreakdown: json("per_channel_breakdown").notNull(),
    voluntaryChurnRateBps: integer("voluntary_churn_rate_bps"),
    involuntaryChurnRateBps: integer("involuntary_churn_rate_bps"),
    netRevenueRetentionBps: integer("net_revenue_retention_bps"),
    grossRevenueRetentionBps: integer("gross_revenue_retention_bps"),
    currency: text("currency").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("mrr_snapshots_account_idx").on(t.accountId)],
);

export const intelligenceReports = sqliteTable(
  "intelligence_reports",
  {
    id: id(),
    accountId: text("account_id").references(() => accounts.id),
    reportMonth: ts("report_month").notNull(),
    narrative: text("narrative").notNull(),
    generatedAt: ts("generated_at").notNull(),
  },
  (t) => [
    index("intelligence_reports_account_idx").on(t.accountId),
    // PRICING.md's "nightly AI analyst narrative" refreshes the SAME monthly
    // report every night (upsert), it does not accumulate a new archival row
    // per night: one row per account per report_month, kept current.
    uniqueIndex("intelligence_reports_account_month_uq").on(t.accountId, t.reportMonth),
  ],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    metric: text("metric").notNull(),
    thresholdValue: real("threshold_value").notNull(),
    direction: text("direction").notNull(),
    channel: text("channel").notNull(),
    label: text("label"),
    enabled: bool("enabled").notNull().default(true),
    lastTriggeredAt: ts("last_triggered_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("alerts_account_idx").on(t.accountId)],
);

export const alertHistory = sqliteTable(
  "alert_history",
  {
    id: id(),
    alertId: text("alert_id").notNull().references(() => alerts.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    metric: text("metric").notNull(),
    thresholdValue: real("threshold_value").notNull(),
    direction: text("direction").notNull(),
    actualValue: real("actual_value").notNull(),
    channel: text("channel").notNull(),
    firedAt: ts("fired_at").notNull(),
    notificationSent: bool("notification_sent").notNull().default(false),
  },
  (t) => [
    index("alert_history_account_idx").on(t.accountId),
    index("alert_history_alert_idx").on(t.alertId),
  ],
);

export const intelligenceNotificationPreferences = sqliteTable(
  "intelligence_notification_preferences",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    // soft ref to Better Auth user.id (Phase 3)
    userId: text("user_id").notNull(),
    weeklyNarrativeEmail: bool("weekly_narrative_email").notNull().default(true),
    weeklyNarrativeSlack: bool("weekly_narrative_slack").notNull().default(false),
    healthAlertEmail: bool("health_alert_email").notNull().default(true),
    healthAlertSlack: bool("health_alert_slack").notNull().default(false),
    healthAlertThreshold: integer("health_alert_threshold").notNull().default(50),
    expansionAlertEmail: bool("expansion_alert_email").notNull().default(true),
    expansionAlertSlack: bool("expansion_alert_slack").notNull().default(false),
    competitorAlertEmail: bool("competitor_alert_email").notNull().default(false),
    competitorAlertSlack: bool("competitor_alert_slack").notNull().default(false),
    anomalyAlertEmail: bool("anomaly_alert_email").notNull().default(true),
    anomalyAlertSlack: bool("anomaly_alert_slack").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("intelligence_notif_prefs_account_idx").on(t.accountId)],
);

// global (not tenant-scoped): seeds the no-auth estimator
export const benchmarkData = sqliteTable("benchmark_data", {
  id: id(),
  computedAt: ts("computed_at").notNull(),
  cohortDimension: text("cohort_dimension").notNull(),
  cohortValue: text("cohort_value").notNull(),
  sampleSize: integer("sample_size").notNull(),
  metricName: text("metric_name").notNull(),
  p10: real("p10"),
  p25: real("p25"),
  p50: real("p50"),
  p75: real("p75"),
  p90: real("p90"),
  mean: real("mean"),
  currency: text("currency"),
});

// ============================================================================
// Audit product
// ============================================================================

export const auditRuns = sqliteTable(
  "audit_runs",
  {
    id: id(),
    accountId: text("account_id").references(() => accounts.id),
    stripeAccountId: text("stripe_account_id"),
    runAt: ts("run_at").notNull(),
    lookbackDays: integer("lookback_days").notNull(),
    failedInvoicesCount: integer("failed_invoices_count"),
    failedInvoicesCents: integer("failed_invoices_cents"),
    expiringCardsCount: integer("expiring_cards_count"),
    expiringCardsMrrCents: integer("expiring_cards_mrr_cents"),
    pastDueSubscriptionsCount: integer("past_due_subscriptions_count"),
    pastDueSubscriptionsCents: integer("past_due_subscriptions_cents"),
    openDisputesCount: integer("open_disputes_count"),
    openDisputesCents: integer("open_disputes_cents"),
    disputesAcceptedCount: integer("disputes_accepted_count"),
    disputesWon: integer("disputes_won"),
    disputesLost: integer("disputes_lost"),
    mrrCents: integer("mrr_cents"),
    arrCents: integer("arr_cents"),
    activeSubscriptionsCount: integer("active_subscriptions_count"),
    voluntaryChurnRateBps: integer("voluntary_churn_rate_bps"),
    involuntaryChurnRateBps: integer("involuntary_churn_rate_bps"),
    aiSummary: text("ai_summary"),
    declineBreakdown: json("decline_breakdown"),
    isAuthenticated: bool("is_authenticated"),
    createdAt: ts("created_at").notNull(),
    disputesAcceptedCents: integer("disputes_accepted_cents"),
    currency: text("currency"),
    cardUpdaterEventsInWindow: integer("card_updater_events_in_window"),
    cardUpdaterExpiredDeclinesInWindow: integer("card_updater_expired_declines_in_window"),
    cardUpdaterAdvisory: text("card_updater_advisory"),
    expiresByMonth: json("expires_by_month"),
    // Explicit lift fields (SCHEMA.md): the audit's three bands.
    stripeBaselineRecoveredCents: integer("stripe_baseline_recovered_cents"),
    stillDyingCents: integer("still_dying_cents"),
    foxhoundAddsCents: integer("foxhound_adds_cents"),
  },
  (t) => [index("audit_runs_account_idx").on(t.accountId)],
);

// NEW: no-auth Turnstile-gated estimator; minimal PII (inputs + result only)
export const estimatorRuns = sqliteTable("estimator_runs", {
  id: id(),
  createdAt: ts("created_at").notNull(),
  mrrCents: integer("mrr_cents"),
  customerCount: integer("customer_count"),
  currency: text("currency"),
  estimatedLeakageCents: integer("estimated_leakage_cents"),
  benchmarkCohort: text("benchmark_cohort"),
  resultJson: json("result_json"),
});

// ============================================================================
// Platform / ops
// ============================================================================

export const outcomes = sqliteTable(
  "outcomes",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    product: text("product").notNull(),
    eventType: text("event_type").notNull(),
    eventData: json("event_data"),
    outcome: text("outcome"),
    outcomeAt: ts("outcome_at"),
    createdAt: ts("created_at"),
    // idempotency key (SCHEMA.md spine #4); nullable for carried rows, required in app writes
    idempotencyKey: text("idempotency_key"),
    attributionKind: text("attribution_kind"),
    attributedRef: text("attributed_ref"),
  },
  (t) => [
    index("outcomes_account_idx").on(t.accountId),
    uniqueIndex("outcomes_idempotency_uq")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: id(),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    receivedAt: ts("received_at").notNull(),
    accountId: text("account_id"),
    processed: bool("processed").notNull().default(false),
    errorMessage: text("error_message"),
    payload: json("payload").notNull(),
    processingStartedAt: ts("processing_started_at"),
  },
  (t) => [
    index("webhook_events_account_idx").on(t.accountId),
    uniqueIndex("webhook_events_stripe_event_uq").on(t.stripeEventId),
  ],
);

// global
export const cronConfig = sqliteTable("cron_config", {
  cronName: text("cron_name").primaryKey(),
  enabled: bool("enabled").notNull().default(true),
  minIntervalMinutes: integer("min_interval_minutes"),
  updatedAt: ts("updated_at").notNull(),
});

// global: single canonical run log (cron_runs merged in)
export const cronRunHistory = sqliteTable(
  "cron_run_history",
  {
    id: id(),
    cronName: text("cron_name").notNull(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at").notNull(),
    status: text("status").notNull(),
    rowsProcessed: integer("rows_processed"),
    message: text("message"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("cron_run_history_cron_idx").on(t.cronName)],
);

// global
export const adminAuditLog = sqliteTable("admin_audit_log", {
  id: id(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  // soft ref to Better Auth user.id (Phase 3)
  targetUserId: text("target_user_id"),
  targetEmail: text("target_email"),
  metadata: json("metadata"),
  createdAt: ts("created_at").notNull(),
});

export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: id(),
    accountId: text("account_id").references(() => accounts.id),
    source: text("source").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    costCents: integer("cost_cents").notNull(),
    // internal cost is USD; currency column present to satisfy the money+currency rule
    currency: text("currency").notNull().default("usd"),
    relatedId: text("related_id"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("ai_calls_account_idx").on(t.accountId)],
);

// ai_calls retention target (ARCHITECTURE.md: raw 90 days, monthly cost aggregates
// after). One row per (account, model, YYYY-MM); the retention sweeper aggregates
// aged raw rows here then deletes them in the same atomic batch. account_id is a
// soft aggregate key (no FK), storing "" for platform-level (null-account) calls
// so the unique index dedupes them too.
export const aiCallsMonthly = sqliteTable(
  "ai_calls_monthly",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    model: text("model").notNull(),
    month: text("month").notNull(), // YYYY-MM (UTC)
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [uniqueIndex("ai_calls_monthly_uq").on(t.accountId, t.model, t.month)],
);

// global single-row rollup; total_recovered_usd is a USD-denominated aggregate by definition
export const platformStats = sqliteTable("platform_stats", {
  id: integer("id").primaryKey(),
  totalRecoveredUsd: integer("total_recovered_usd"),
  totalMerchants: integer("total_merchants"),
  totalFailedDetected: integer("total_failed_detected"),
  totalEmailsSent: integer("total_emails_sent"),
  avgRecoveryRatePct: real("avg_recovery_rate_pct"),
  avgHoursToFirstRecovery: real("avg_hours_to_first_recovery"),
  lastComputedAt: ts("last_computed_at"),
});

export const customerNotes = sqliteTable(
  "customer_notes",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("customer_notes_account_idx").on(t.accountId)],
);

// NEW: daily aggregate per path (raw page_404s rows are not migrated; see legacy-map.md)
export const page404Daily = sqliteTable(
  "page_404_daily",
  {
    id: id(),
    day: ts("day").notNull(),
    path: text("path").notNull(),
    hitCount: integer("hit_count").notNull().default(0),
  },
  (t) => [uniqueIndex("page_404_daily_day_path_uq").on(t.day, t.path)],
);

// ============================================================================
// Content / growth (global)
// ============================================================================

export const blogPosts = sqliteTable(
  "blog_posts",
  {
    id: id(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt").notNull(),
    body: text("body").notNull(),
    coverImageUrl: text("cover_image_url"),
    coverImageAlt: text("cover_image_alt"),
    published: bool("published").notNull().default(false),
    publishedAt: ts("published_at"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    author: text("author").notNull(),
    tags: json<string[]>("tags").notNull(),
    ogTitle: text("og_title"),
    ogDescription: text("og_description"),
    canonicalUrl: text("canonical_url"),
    showUpdatedAt: bool("show_updated_at").notNull().default(true),
    showPublishedAt: bool("show_published_at").notNull().default(true),
    featured: bool("featured").notNull().default(false),
    // Precomputed at write time (createPost/updatePostWithVersion) from body's
    // word count, so a list/tag-archive read never needs the full body just to
    // show a card's reading time (perf-audit fix, foxhound-audit-perf.md M-2).
    readingMinutes: integer("reading_minutes").notNull().default(1),
  },
  (t) => [
    uniqueIndex("blog_posts_slug_uq").on(t.slug),
    // Every public list query filters WHERE published = true ORDER BY
    // published_at DESC (listPublishedPosts, getAllPublishedPosts, the tag
    // archive, sitemap/feed/llms generators); no supporting index existed
    // (perf-audit L-2), invisible at 45 rows but a real gap as content scales.
    index("blog_posts_published_published_at_idx").on(t.published, t.publishedAt),
  ],
);

export const blogPostLinks = sqliteTable(
  "blog_post_links",
  {
    id: id(),
    sourceId: text("source_id").notNull().references(() => blogPosts.id),
    targetId: text("target_id").notNull().references(() => blogPosts.id),
    position: integer("position").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("blog_post_links_source_idx").on(t.sourceId)],
);

export const blogPostVersions = sqliteTable(
  "blog_post_versions",
  {
    id: id(),
    postId: text("post_id").notNull().references(() => blogPosts.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    excerpt: text("excerpt").notNull(),
    savedAt: ts("saved_at").notNull(),
    savedBy: text("saved_by"),
  },
  (t) => [index("blog_post_versions_post_idx").on(t.postId)],
);

export const socialConfig = sqliteTable("social_config", {
  id: id(),
  platform: text("platform").notNull(),
  enabled: bool("enabled").notNull().default(false),
  postEnabled: bool("post_enabled").notNull().default(false),
  replyEnabled: bool("reply_enabled").notNull().default(false),
  redditReady: bool("reddit_ready").notNull().default(false),
  maxRepliesPerDay: integer("max_replies_per_day").notNull(),
  minIntentScore: integer("min_intent_score").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  maxPostAgeHours: integer("max_post_age_hours").notNull(),
  minUpvotes: integer("min_upvotes").notNull(),
  postsPerWeek: integer("posts_per_week").notNull(),
});

export const socialKeywords = sqliteTable("social_keywords", {
  id: id(),
  platform: text("platform").notNull(),
  query: text("query").notNull(),
  enabled: bool("enabled").notNull().default(true),
  createdAt: ts("created_at").notNull(),
  isCompetitor: bool("is_competitor").notNull().default(false),
  lastUsedAt: ts("last_used_at"),
  leadCount: integer("lead_count").notNull().default(0),
});

export const socialLeads = sqliteTable(
  "social_leads",
  {
    id: id(),
    platform: text("platform").notNull(),
    postUrl: text("post_url").notNull(),
    postId: text("post_id"),
    author: text("author"),
    title: text("title"),
    body: text("body"),
    subreddit: text("subreddit"),
    intentScore: integer("intent_score").notNull(),
    keywordsMatched: json<string[]>("keywords_matched"),
    status: text("status").notNull(),
    replyId: text("reply_id"),
    replyBody: text("reply_body"),
    scoutRunAt: ts("scout_run_at").notNull(),
    repliedAt: ts("replied_at"),
    skipReason: text("skip_reason"),
    createdAt: ts("created_at").notNull(),
    upvoteCount: integer("upvote_count"),
    postAgeHours: integer("post_age_hours"),
    filterReason: text("filter_reason"),
    sentiment: text("sentiment"),
    isCompetitorMention: bool("is_competitor_mention").notNull().default(false),
    isGoogleRanking: bool("is_google_ranking").notNull().default(false),
    generatedReply: text("generated_reply"),
    replyApprovedAt: ts("reply_approved_at"),
    keywordId: text("keyword_id").references(() => socialKeywords.id),
  },
  (t) => [index("social_leads_keyword_idx").on(t.keywordId)],
);

export const socialPosts = sqliteTable(
  "social_posts",
  {
    id: id(),
    platform: text("platform").notNull(),
    postType: text("post_type").notNull(),
    content: text("content").notNull(),
    platformPostId: text("platform_post_id"),
    leadId: text("lead_id").references(() => socialLeads.id),
    status: text("status").notNull(),
    error: text("error"),
    postedAt: ts("posted_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("social_posts_lead_idx").on(t.leadId)],
);

export const socialTopicLog = sqliteTable("social_topic_log", {
  id: id(),
  topicKey: text("topic_key").notNull(),
  platform: text("platform").notNull(),
  usedAt: ts("used_at").notNull(),
});

export const socialBlocklist = sqliteTable("social_blocklist", {
  id: id(),
  type: text("type").notNull(),
  value: text("value").notNull(),
  reason: text("reason"),
  createdAt: ts("created_at").notNull(),
});
