import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool, json } from "./columns";
import { failedPayments } from "./recovery";
import { accounts, stripeConnections } from "./tenancy";

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
    /** The USD-to-dispute-currency rate the $500 cap was converted at, with the
     *  quote that produced it and when (ruling 377(7), PRICING rev 5 item 2).
     *  Null on a USD dispute, where nothing is converted. Stored so the ledger
     *  line can show the merchant the rate they were capped at rather than
     *  asking them to take the number on trust. */
    resolvedFeeRate: real("resolved_fee_rate"),
    resolvedFeeQuoteId: text("resolved_fee_quote_id"),
    resolvedFeeRateAt: ts("resolved_fee_rate_at"),
    /** Why the fee could NOT be snapshotted. Set when the FX quote failed, in
     *  which case resolved_fee_cents stays null and the dispute is not billable
     *  until it is resolved again. Fail closed, never a flat-cap fallback. */
    resolvedFeeError: text("resolved_fee_error"),
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
// Early fraud warnings (Stripe radar.early_fraud_warning)
// ============================================================================

/**
 * One row per Stripe early fraud warning on a connected account. A card network
 * sends one days or weeks before a fraud chargeback, and refunding the charge
 * first avoids the dispute fee and keeps the dispute off the merchant's ratio.
 *
 * Written by the connected-account webhook (radar.early_fraud_warning.created
 * and .updated) and by the merchant's Refund or Dismiss on the disputes page.
 * Nothing here is billable: a refund is not a won dispute.
 */
export const earlyFraudWarnings = sqliteTable(
  "early_fraud_warnings",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeConnectionId: text("stripe_connection_id").references(() => stripeConnections.id),
    stripeWarningId: text("stripe_warning_id").notNull(),
    stripeChargeId: text("stripe_charge_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeCustomerId: text("stripe_customer_id"),
    /** The charge's billing name and email, for the page and the notice. */
    customerEmail: text("customer_email"),
    customerName: text("customer_name"),
    /** The Foxhound recovery this charge was taken in, when it was one. */
    failedPaymentId: text("failed_payment_id").references(() => failedPayments.id),
    /** Stripe's fraud_type, as sent (card_never_received, stolen card, ...). */
    fraudType: text("fraud_type").notNull(),
    /** Stripe's own flag: false once the charge is fully refunded or disputed. */
    actionable: bool("actionable").notNull(),
    /** From the charge, read when the warning arrives. */
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    /** When Stripe created the warning. */
    createdAt: ts("created_at").notNull(),
    receivedAt: ts("received_at").notNull(),
    refundedAt: ts("refunded_at"),
    stripeRefundId: text("stripe_refund_id"),
    dismissedAt: ts("dismissed_at"),
  },
  (t) => [
    index("early_fraud_warnings_account_idx").on(t.accountId),
    uniqueIndex("early_fraud_warnings_account_warning_uq").on(t.accountId, t.stripeWarningId),
  ],
);
