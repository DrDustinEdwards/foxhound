import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts } from "./columns";
import { disputes } from "./disputes";
import { adminAuditLog } from "./platform";
import { recoveredPayments } from "./recovery";
import { accountRef } from "./tenancy";

export const billingInvoices = sqliteTable(
  "billing_invoices",
  {
    id: id(),
    accountId: accountRef(),
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
    // Charge-dispatch retry bookkeeping (app/lib/billing/fee-retry.ts): the state machine caps how many times Foxhound chases one fee invoice, and nothing else in the schema can derive an attempt count.
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
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => billingInvoices.id),
    accountId: accountRef(),
    // recovery_fee | dispute_fee | subscription | adjustment | credit (PRICING.md)
    type: text("type").notNull(),
    currency: text("currency").notNull(),
    // signed for adjustment; otherwise the billed amount in cents
    amountCents: integer("amount_cents").notNull(),
    feeCents: integer("fee_cents"),
    // evidence FKs: exactly one set for recovery_fee / dispute_fee
    recoveredPaymentId: text("recovered_payment_id").references(() => recoveredPayments.id),
    disputeId: text("dispute_id").references(() => disputes.id),
    // adjustment requires an admin_audit_log entry; DB-enforced below
    adminAuditLogId: text("admin_audit_log_id").references(() => adminAuditLog.id),
    description: text("description"),
    createdAt: ts("created_at").notNull(),
    /** The Stripe credit note this line records (type 'credit' only), so the ledger can show the merchant the note and a replay can recognize the work as already done. */
    stripeCreditNoteId: text("stripe_credit_note_id"),
    /** The fee line this credit reverses (type 'credit' only). A self-reference rather than a bare flag, so "one credit note per fee line" can be a unique index. */
    creditsLineItemId: text("credits_line_item_id"),
    /** recovery_fee lines only: the recovery's refunded_cents this fee and its
     *  credit already account for. A larger refunded_cents on the recovery is
     *  a refund not yet reflected, which the credit path settles. */
    refundedCents: integer("refunded_cents").notNull().default(0),
  },
  (t) => [
    index("billing_line_items_invoice_idx").on(t.invoiceId),
    index("billing_line_items_account_idx").on(t.accountId),
    // STRUCTURAL NO-DOUBLE-BILLING: one FEE line per recovery, one per dispute. Scoped to the fee types because a credit line carries the same evidence FK as the fee it reverses (so the ledger reads action -> recovery -> fee -> credit); a recovery still cannot carry two recovery_fee lines.
    uniqueIndex("billing_line_items_recovery_uq")
      .on(t.recoveredPaymentId)
      .where(sql`${t.recoveredPaymentId} is not null and ${t.type} = 'recovery_fee'`),
    uniqueIndex("billing_line_items_dispute_uq")
      .on(t.disputeId)
      .where(sql`${t.disputeId} is not null and ${t.type} = 'dispute_fee'`),
    check(
      "billing_line_items_type_ck",
      sql`${t.type} in ('recovery_fee', 'dispute_fee', 'subscription', 'adjustment', 'credit')`,
    ),
    // ONE CREDIT NOTE PER FEE LINE, enforced by the database: a redelivered refund event, or two racing, cannot produce a second credit against the same fee; the insert violates this index and the whole money batch rolls back.
    uniqueIndex("billing_line_items_credits_line_uq").on(t.creditsLineItemId),
    // A credit line is meaningless without the fee it reverses and the note
    // Stripe issued, and no other type may carry them.
    check(
      "billing_line_items_credit_shape_ck",
      sql`(${t.type} = 'credit') = (${t.creditsLineItemId} is not null)`,
    ),
    // An adjustment line item is never valid without its admin_audit_log entry. DB-enforced, not just app-enforced; other types leave admin_audit_log_id null.
    check(
      "billing_line_items_adjustment_audit_ck",
      sql`${t.type} != 'adjustment' or ${t.adminAuditLogId} is not null`,
    ),
  ],
);

/**
 * When an account was billing exempt. An exemption FORGIVES: a recovery or dispute win whose fee was earned or came due while the account was exempt is never billed, not held for the first run after the exemption ends. Foxhound bills by maturity with no lower date bound, so it needs the stretches themselves; accounts.billing_exempt only says what is true now.
 * One row per stretch, [started_at, ended_at), ended_at null while it lasts. Written only by setBillingExempt's money write, in the same atomic batch as the accounts.billing_exempt flag, so the two never disagree. Read only by app/db/billable.ts.
 */
export const billingExemptionPeriods = sqliteTable(
  "billing_exemption_periods",
  {
    id: id(),
    accountId: accountRef(),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    /** The change that ended this stretch, so the caller can tell its own
     *  "End exemption" from one that matched nothing. */
    endedByChangeId: text("ended_by_change_id"),
  },
  (t) => [
    index("billing_exemption_periods_account_idx").on(t.accountId),
    // At most one open stretch per account.
    uniqueIndex("billing_exemption_periods_open_uq")
      .on(t.accountId)
      .where(sql`${t.endedAt} is null`),
  ],
);
