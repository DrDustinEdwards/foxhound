import { and, eq, getTableColumns, inArray, isNotNull, isNull, lte, notLike, sql, type SQL } from "drizzle-orm";

import { BILLABLE_ATTRIBUTION_KINDS, DEMO_ACCOUNT_ID_PREFIX, RECOVERY_MATURITY_MS } from "~/lib/constants";
import type { Db } from "./client";
import { accounts, billingInvoices, billingLineItems, disputeApprovals, disputes, recoveredPayments } from "./schema";

// THE single source of truth for the billable sets (PRICING.md maturity-window
// billing + SCHEMA.md spine #3). No other module reimplements these predicates.
// A recovery bills only when ALL hold:
//   - attributed to a Foxhound action (attribution_kind is one of
//     BILLABLE_ATTRIBUTION_KINDS, the same allow-list app/lib/recovery/attribution.ts's
//     isBillableAttribution uses, consolidated here 2026-07-19 per Phase 5 review
//     LOW/INFO finding: this used to be a deny-list, attribution_kind != 'stripe_baseline',
//     which happened to be equivalent only because exactly four attribution kinds exist. A
//     fifth kind added to the schema CHECK constraint in the future would have silently
//     become billable by default under the old deny-list; the allow-list fails closed instead),
//   - matured >= RECOVERY_MATURITY_DAYS (recovered_at <= asOf - maturity),
//   - not refunded, not disputed, not soft-deleted,
//   - not already billed (no billing_line_item references it),
//   - the account is billing-eligible (not exempt, not paused, not a demo account).
// A won dispute bills only when Foxhound actually drafted AND submitted the
// evidence (PRICING.md rev 3: "Billable only if Foxhound drafted AND submitted
// the evidence. Merchant-fought disputes are never billed."). The proof of a
// Foxhound submission is BOTH a dispute_approvals row (the merchant's explicit
// sign-off) AND disputes.submitted_at set (written only after Stripe accepted
// the submission; see app/lib/disputes/approval.ts buildSubmissionConfirmationBatch).
// A merchant-fought or auto-resolved win has neither and yields ZERO fee, even
// though its state is resolved_won. On top of that: resolved_won by asOf, not
// previously billed, and the account is billing-eligible.

/** Account-level billing gate (PRICING.md: billing_exempt / processing_paused
 *  honored in the billable query itself; demo accounts never bill). Applied via an
 *  inner join on accounts in every billable query below. */
export function accountBillingEligibleCondition(): SQL {
  return and(
    eq(accounts.billingExempt, false),
    eq(accounts.processingPaused, false),
    notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
  ) as SQL;
}

/** Row-level billable conditions for recoveries (everything except the
 *  not-already-billed clause, which is a join and lives in the query below). */
export function billableRecoveryRowConditions(accountId: string, asOfMs: number): SQL {
  const maturityCutoff = new Date(asOfMs - RECOVERY_MATURITY_MS);
  return and(
    eq(recoveredPayments.accountId, accountId),
    inArray(recoveredPayments.attributionKind, BILLABLE_ATTRIBUTION_KINDS),
    lte(recoveredPayments.recoveredAt, maturityCutoff),
    isNull(recoveredPayments.refundedAt),
    isNull(recoveredPayments.disputedAt),
    isNull(recoveredPayments.deletedAt),
  ) as SQL;
}

/**
 * The canonical billable-recovery query for one account as of `asOfMs`.
 * Inner-joins accounts (billing-eligibility gate) and left-joins billing_line_items,
 * keeping only rows with no existing line item (structural "not previously billed").
 * Returns recovered_payments rows.
 */
export function getBillableRecoveries(db: Db, accountId: string, asOfMs: number) {
  return db
    .select(getTableColumns(recoveredPayments))
    .from(recoveredPayments)
    .innerJoin(accounts, eq(accounts.id, recoveredPayments.accountId))
    .leftJoin(
      billingLineItems,
      eq(billingLineItems.recoveredPaymentId, recoveredPayments.id),
    )
    .where(
      and(
        billableRecoveryRowConditions(accountId, asOfMs),
        accountBillingEligibleCondition(),
        isNull(billingLineItems.id),
      ),
    );
}

/** Row-level billable conditions for disputes: resolved_won by asOf AND Foxhound
 *  actually submitted it (disputes.submitted_at set post-Stripe-acceptance). The
 *  dispute_approvals-row requirement is the inner join in getBillableDisputes.
 *  Disputes have no maturity window (PRICING.md: billed at the next run after
 *  resolution); the resolved fee snapshot on the row already carries the cap
 *  applied at resolution. */
export function billableDisputeRowConditions(accountId: string, asOfMs: number): SQL {
  return and(
    eq(disputes.accountId, accountId),
    eq(disputes.state, "resolved_won"),
    isNotNull(disputes.submittedAt),
    lte(disputes.resolvedAt, new Date(asOfMs)),
  ) as SQL;
}

/**
 * The canonical billable-dispute query for one account as of `asOfMs`.
 * Inner-joins accounts (billing-eligibility gate) AND dispute_approvals (the
 * Foxhound-submission proof: no approval row = never billed, PRICING.md rev 3),
 * and left-joins billing_line_items, keeping only disputes with no existing
 * dispute_fee line item (structural "not previously billed"; the dispute unique
 * index prevents double-billing on reopen). dispute_approvals is unique per
 * dispute_id, so the inner join cannot fan a dispute into multiple billable
 * rows. Returns disputes rows.
 */
export function getBillableDisputes(db: Db, accountId: string, asOfMs: number) {
  return db
    .select(getTableColumns(disputes))
    .from(disputes)
    .innerJoin(accounts, eq(accounts.id, disputes.accountId))
    .innerJoin(disputeApprovals, eq(disputeApprovals.disputeId, disputes.id))
    .leftJoin(billingLineItems, eq(billingLineItems.disputeId, disputes.id))
    .where(
      and(
        billableDisputeRowConditions(accountId, asOfMs),
        accountBillingEligibleCondition(),
        isNull(billingLineItems.id),
      ),
    );
}


/** Everything the guarded recovery-fee line insert needs. The fee is computed
 *  in Foxhound code and passed in as a bound constant: the 20% rate stays out
 *  of SQL (PRICING.md, "the rates live in Foxhound code"). */
export interface GuardedRecoveryLineInput {
  lineItemId: string;
  invoiceId: string;
  accountId: string;
  currency: string;
  recoveredPaymentId: string;
  feeCents: number;
  description: string;
  createdAt: Date;
  /** The same asOf the billable read used, so the batch re-evaluates the SAME
   *  maturity cutoff rather than a slightly later one. */
  asOfMs: number;
}

/**
 * A recovery-fee line item that RE-CHECKS THE BILLABLE PREDICATE AS IT WRITES.
 *
 * The billing run reads the billable set outside the Durable Object and then
 * inserted from that in-memory list (ruling 376(3)). The per-account DO
 * serializes the WRITES, not the read, so a refund landing in the gap between
 * the two was invoiced: the row was billable when it was read and was not when
 * it was written, and nothing looked again.
 *
 * This is an INSERT ... SELECT, so the predicate is evaluated by the database
 * at write time, inside the batch, against the row as it exists at that moment.
 * A refunded, disputed, deleted, unmatured or no-longer-attributed recovery
 * selects zero rows and inserts zero lines; nothing else about the batch
 * changes, and the invoice total is derived from the lines that actually
 * landed rather than the ones that were hoped for.
 *
 * DISPUTES ARE THE SAME CLASS AND ARE DELIBERATELY NOT CONVERTED HERE. 377's
 * dispatch scopes 376(3) to the recovery predicate, a dispute's billable state
 * is a state-machine transition rather than a stamped column, and the unique
 * index on dispute_id already stops the double-bill that matters. Left as a
 * named gap rather than a silent one.
 */
export function buildGuardedRecoveryLineInsert(db: Db, input: GuardedRecoveryLineInput) {
  return db.insert(billingLineItems).select(
    db
      .select({
        // Projected in the table's own column order. The `id` default is a
        // JS-side $defaultFn and does NOT fire on an insert-select, so the
        // caller supplies a deterministic id.
        id: sql<string>`${input.lineItemId}`.as("id"),
        invoiceId: sql<string>`${input.invoiceId}`.as("invoice_id"),
        accountId: sql<string>`${input.accountId}`.as("account_id"),
        type: sql<string>`${"recovery_fee"}`.as("type"),
        currency: sql<string>`${input.currency}`.as("currency"),
        amountCents: sql<number>`${input.feeCents}`.as("amount_cents"),
        feeCents: sql<number>`${input.feeCents}`.as("fee_cents"),
        // Taken from the SELECTED row, not from the caller: if no row survives
        // the predicate there is nothing to point the evidence FK at.
        recoveredPaymentId: recoveredPayments.id,
        disputeId: sql<string | null>`null`.as("dispute_id"),
        adminAuditLogId: sql<string | null>`null`.as("admin_audit_log_id"),
        description: sql<string>`${input.description}`.as("description"),
        createdAt: sql<number>`${input.createdAt.getTime()}`.as("created_at"),
        // Added by ruling 377(5). A fee line is not a credit, so both are null,
        // but drizzle's insert-select requires EVERY column in table order and
        // an omission is a runtime error, not a type error.
        stripeCreditNoteId: sql<string | null>`null`.as("stripe_credit_note_id"),
        creditsLineItemId: sql<string | null>`null`.as("credits_line_item_id"),
      })
      .from(recoveredPayments)
      .where(
        and(
          eq(recoveredPayments.id, input.recoveredPaymentId),
          billableRecoveryRowConditions(input.accountId, input.asOfMs),
        ),
      ),
  );
}

/**
 * Set an invoice's total from the line items that ACTUALLY COMMITTED.
 *
 * The companion to the guarded insert above and not optional beside it: if a
 * line can silently not land, a total computed in JS from the pre-write list
 * overstates the invoice by exactly the fee that was withdrawn. Derived in the
 * same batch so the invoice and its lines can never disagree.
 */
export function buildInvoiceTotalFromLines(db: Db, invoiceId: string) {
  return db
    .update(billingInvoices)
    .set({
      totalCents: sql<number>`(select coalesce(sum(${billingLineItems.amountCents}), 0) from ${billingLineItems} where ${billingLineItems.invoiceId} = ${invoiceId})`,
    })
    .where(eq(billingInvoices.id, invoiceId));
}
