import { and, eq, getTableColumns, gt, inArray, isNotNull, isNull, lte, notExists, notLike, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";

import { BILLABLE_ATTRIBUTION_KINDS, DEMO_ACCOUNT_ID_PREFIX, RECOVERY_MATURITY_MS } from "~/lib/constants";
import type { Db } from "./client";
import {
  accounts,
  billingExemptionPeriods,
  billingInvoices,
  billingLineItems,
  disputeApprovals,
  disputes,
  recoveredPayments,
} from "./schema";

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
//   - the account is billing-eligible (not exempt, not paused, not a demo account),
//   - and no billing exemption forgave it (exemptionForgaveRecovery below).
// A won dispute bills only when Foxhound actually drafted AND submitted the
// evidence (PRICING.md rev 3: "Billable only if Foxhound drafted AND submitted
// the evidence. Merchant-fought disputes are never billed."). The proof of a
// Foxhound submission is BOTH a dispute_approvals row (the merchant's explicit
// sign-off) AND disputes.submitted_at set (written only after Stripe accepted
// the submission; see app/lib/disputes/approval.ts buildSubmissionConfirmationBatch).
// A merchant-fought or auto-resolved win has neither and yields ZERO fee, even
// though its state is resolved_won. On top of that: resolved_won by asOf, not
// previously billed, the account is billing-eligible, and no billing exemption
// forgave it (exemptionForgaveDispute below).
//
// AN EXEMPTION FORGIVES (Dustin, 2026-10-25, "Forgive, like Recova"). Recova
// billed only the prior calendar month and skipped exempt accounts, so a fee
// that came due while an account was exempt was never billed. The run-time
// billing_exempt gate alone only HELD such fees for the first run after the
// exemption ended. A fee is forgiven when an exempt stretch
// (billing_exemption_periods, [started_at, ended_at)) covered the moment it
// was earned, or any moment it was due and unbilled: from maturity (a
// recovery) or resolution (a dispute) up to asOf. Only stretches that had
// started by asOf count, so a run never forgives on an exemption set after it.

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

// The correlated subqueries need no db handle, so the row-condition builders
// keep their signatures and the guarded insert re-checks forgiveness as it writes.
const qb = new QueryBuilder();

/** The stretch belongs to the row's account and had not ended by `from`. */
function stretchOfRowNotEndedBy(rowAccountId: AnyColumn, from: AnyColumn | SQL): SQL {
  return and(
    eq(billingExemptionPeriods.accountId, rowAccountId),
    or(isNull(billingExemptionPeriods.endedAt), gt(billingExemptionPeriods.endedAt, from)),
  ) as SQL;
}

/** A recovery is forgiven when an exempt stretch covered the moment it was
 *  recovered (no fee builds up while exempt), or any moment from its maturity
 *  to asOf (it came due, unbilled, while exempt). */
export function exemptionForgaveRecovery(asOfMs: number): SQL {
  const maturedAt = sql`${recoveredPayments.recoveredAt} + ${RECOVERY_MATURITY_MS}`;
  return notExists(
    qb
      .select({ one: sql`1` })
      .from(billingExemptionPeriods)
      .where(
        and(
          stretchOfRowNotEndedBy(recoveredPayments.accountId, recoveredPayments.recoveredAt),
          or(
            lte(billingExemptionPeriods.startedAt, recoveredPayments.recoveredAt),
            and(
              lte(billingExemptionPeriods.startedAt, new Date(asOfMs)),
              stretchOfRowNotEndedBy(recoveredPayments.accountId, maturedAt),
            ),
          ),
        ),
      ),
  );
}

/** A dispute win is forgiven when an exempt stretch covered any moment from its
 *  resolution to asOf. */
function exemptionForgaveDispute(asOfMs: number): SQL {
  return notExists(
    qb
      .select({ one: sql`1` })
      .from(billingExemptionPeriods)
      .where(
        and(
          stretchOfRowNotEndedBy(disputes.accountId, disputes.resolvedAt),
          lte(billingExemptionPeriods.startedAt, new Date(asOfMs)),
        ),
      ),
  );
}

/** Row-level billable conditions for recoveries (everything except the
 *  not-already-billed clause, which is a join and lives in the query below,
 *  and the exemption clause, exemptionForgaveRecovery). The exemption clause
 *  stays out because it only holds for a fee not yet billed: it asks whether
 *  an exemption covered any moment up to asOf, so an exemption set long after
 *  a fee was invoiced would match it too. Readers of what to bill next add it
 *  (getBillableRecoveries, buildGuardedRecoveryLineInsert); a reader that also
 *  keeps billed rows, like the ROI widget, keeps a billed row whatever it says. */
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
        exemptionForgaveRecovery(asOfMs),
        accountBillingEligibleCondition(),
        isNull(billingLineItems.id),
      ),
    );
}

/** A won dispute Foxhound submitted, resolved by asOf, on a billing-eligible
 *  account, and not forgiven by an exemption: everything billing asks of a win
 *  except its account, the stored fee and the not-yet-billed join. */
function wonFoxhoundDisputeConditions(asOfMs: number): SQL {
  return and(
    eq(disputes.state, "resolved_won"),
    isNotNull(disputes.submittedAt),
    lte(disputes.resolvedAt, new Date(asOfMs)),
    exemptionForgaveDispute(asOfMs),
  ) as SQL;
}

/** Row-level billable conditions for disputes: resolved_won by asOf AND Foxhound
 *  actually submitted it (disputes.submitted_at set post-Stripe-acceptance). The
 *  dispute_approvals-row requirement is the inner join in getBillableDisputes.
 *  Disputes have no maturity window (PRICING.md: billed at the next run after
 *  resolution); the resolved fee snapshot on the row already carries the cap
 *  applied at resolution.
 *
 *  SKIP UNTIL PRICED (Dustin, 2026-10-25). A win whose cap could not be
 *  converted at resolution has no stored fee, and it is left out here rather
 *  than billed at the flat 50,000 in its own currency, which ruling 377(7) says
 *  is never used. Nothing marks it billed, so once the daily pricing retry
 *  (app/lib/disputes/fee-pricing.server.ts) stores its fee, the next run bills
 *  exactly that amount. */
function billableDisputeRowConditions(accountId: string, asOfMs: number): SQL {
  return and(
    eq(disputes.accountId, accountId),
    wonFoxhoundDisputeConditions(asOfMs),
    isNotNull(disputes.resolvedFeeCents),
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

/**
 * Won disputes that would bill but for a stored fee, across every account: the
 * daily pricing retry's work list. Same joins and gates as getBillableDisputes,
 * with the fee clause inverted, so a win priced here is one the next run bills.
 */
export function getUnpricedBillableWins(db: Db, asOfMs: number, limit: number) {
  return db
    .select({
      id: disputes.id,
      accountId: disputes.accountId,
      amountCents: disputes.amountCents,
      currency: disputes.currency,
    })
    .from(disputes)
    .innerJoin(accounts, eq(accounts.id, disputes.accountId))
    .innerJoin(disputeApprovals, eq(disputeApprovals.disputeId, disputes.id))
    .leftJoin(billingLineItems, eq(billingLineItems.disputeId, disputes.id))
    .where(
      and(
        wonFoxhoundDisputeConditions(asOfMs),
        isNull(disputes.resolvedFeeCents),
        accountBillingEligibleCondition(),
        isNull(billingLineItems.id),
      ),
    )
    .orderBy(disputes.resolvedAt)
    .limit(limit);
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
          exemptionForgaveRecovery(input.asOfMs),
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
