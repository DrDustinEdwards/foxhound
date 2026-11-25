import {
  and,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  notLike,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";

import {
  BILLABLE_ATTRIBUTION_KINDS,
  DEMO_ACCOUNT_ID_PREFIX,
  RECOVERY_MATURITY_MS,
} from "~/lib/constants";
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

// The single source of truth for the billable sets (PRICING.md, SCHEMA.md spine #3); no other module reimplements these predicates.
// A recovery bills only when ALL hold: attributed to a Foxhound action (attribution_kind is in BILLABLE_ATTRIBUTION_KINDS, the allow-list app/lib/recovery/attribution.ts's isBillableAttribution uses; an allow-list so a new kind fails closed); matured >= RECOVERY_MATURITY_DAYS (recovered_at <= asOf - maturity); not refunded, not disputed, not soft-deleted; not already billed (no billing_line_item references it); the account is billing-eligible (not exempt, not paused, not a demo account); and no billing exemption forgave it (exemptionForgaveRecovery below).
// A won dispute bills only when Foxhound drafted AND submitted the evidence (PRICING.md rev 3): a dispute_approvals row (the merchant's sign-off) AND disputes.submitted_at set (written only after Stripe accepted the submission; app/lib/disputes/approval.ts buildSubmissionConfirmationBatch). A merchant-fought or auto-resolved win has neither and yields ZERO fee, even though its state is resolved_won. Also: resolved_won by asOf, not previously billed, the account billing-eligible, and no exemption forgave it (exemptionForgaveDispute below).
// AN EXEMPTION FORGIVES. A fee is forgiven when an exempt stretch (billing_exemption_periods, [started_at, ended_at)) covered the moment it was earned, or any moment it was due and unbilled: from maturity (a recovery) or resolution (a dispute) up to asOf. Only stretches that had started by asOf count, so a run never forgives on an exemption set after it.

/** Account-level billing gate (PRICING.md: billing_exempt / processing_paused honored in the billable query itself; demo accounts never bill). Applied via an inner join on accounts in every billable query below. */
export function accountBillingEligibleCondition(): SQL {
  return and(
    eq(accounts.billingExempt, false),
    eq(accounts.processingPaused, false),
    notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
  ) as SQL;
}

const qb = new QueryBuilder();

/** The stretch belongs to the row's account and had not ended by `from`. */
function stretchOfRowNotEndedBy(rowAccountId: AnyColumn, from: AnyColumn | SQL): SQL {
  return and(
    eq(billingExemptionPeriods.accountId, rowAccountId),
    or(isNull(billingExemptionPeriods.endedAt), gt(billingExemptionPeriods.endedAt, from)),
  ) as SQL;
}

/** A recovery is forgiven when an exempt stretch covered its recovery moment, or any moment from maturity to asOf. */
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

/** A dispute win is forgiven when an exempt stretch covered any moment from resolution to asOf. */
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

/** Row-level billable conditions for recoveries, minus the not-already-billed join and exemptionForgaveRecovery. The exemption clause is only valid for unbilled fees (a later exemption would match billed rows), so readers of what to bill next add it. */
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

/** The billable recoveries for one account as of `asOfMs`: eligible account, no existing line item. */
export function getBillableRecoveries(db: Db, accountId: string, asOfMs: number) {
  return db
    .select(getTableColumns(recoveredPayments))
    .from(recoveredPayments)
    .innerJoin(accounts, eq(accounts.id, recoveredPayments.accountId))
    .leftJoin(billingLineItems, eq(billingLineItems.recoveredPaymentId, recoveredPayments.id))
    .where(
      and(
        billableRecoveryRowConditions(accountId, asOfMs),
        exemptionForgaveRecovery(asOfMs),
        accountBillingEligibleCondition(),
        isNull(billingLineItems.id),
      ),
    );
}

/** A won dispute Foxhound submitted, resolved by asOf, not forgiven by an exemption. */
function wonFoxhoundDisputeConditions(asOfMs: number): SQL {
  return and(
    eq(disputes.state, "resolved_won"),
    isNotNull(disputes.submittedAt),
    lte(disputes.resolvedAt, new Date(asOfMs)),
    exemptionForgaveDispute(asOfMs),
  ) as SQL;
}

/**
 * Row-level billable conditions for disputes: resolved_won by asOf AND Foxhound submitted it (submitted_at set after Stripe accepted). No maturity window; the stored fee already carries the cap.
 * SKIP UNTIL PRICED: a win with no stored fee (cap not convertible) is left out until the daily pricing retry stores one.
 */
function billableDisputeRowConditions(accountId: string, asOfMs: number): SQL {
  return and(
    eq(disputes.accountId, accountId),
    wonFoxhoundDisputeConditions(asOfMs),
    isNotNull(disputes.resolvedFeeCents),
  ) as SQL;
}

/** The billable disputes for one account as of `asOfMs`. The dispute_approvals inner join is the Foxhound-submission proof (PRICING.md rev 3); it is unique per dispute_id, so it cannot fan out rows. */
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

/** Won disputes that would bill but for a stored fee, across every account: the daily pricing retry's work list. */
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

/** Input to the guarded recovery-fee line insert. The fee is a bound constant: rates stay out of SQL (PRICING.md). */
export interface GuardedRecoveryLineInput {
  lineItemId: string;
  invoiceId: string;
  accountId: string;
  currency: string;
  recoveredPaymentId: string;
  feeCents: number;
  /** The refunded_cents the fee was computed net of; a refund that changed it selects zero rows. */
  refundedCents: number;
  description: string;
  createdAt: Date;
  /** The asOf the billable read used, so the batch re-evaluates the same cutoff. */
  asOfMs: number;
}

/**
 * A recovery-fee line item that RE-CHECKS THE BILLABLE PREDICATE AS IT WRITES. The DO serializes writes, not the read, so a refund landing between read and insert would otherwise be invoiced. As an INSERT ... SELECT, an ineligible recovery inserts zero lines.
 * Disputes are deliberately not converted: the unique index on dispute_id already stops the double-bill.
 */
export function buildGuardedRecoveryLineInsert(db: Db, input: GuardedRecoveryLineInput) {
  return db.insert(billingLineItems).select(
    db
      .select({
        // Table column order. The `id` $defaultFn does not fire on an insert-select, so the caller supplies the id.
        id: sql<string>`${input.lineItemId}`.as("id"),
        invoiceId: sql<string>`${input.invoiceId}`.as("invoice_id"),
        accountId: sql<string>`${input.accountId}`.as("account_id"),
        type: sql<string>`${"recovery_fee"}`.as("type"),
        currency: sql<string>`${input.currency}`.as("currency"),
        amountCents: sql<number>`${input.feeCents}`.as("amount_cents"),
        feeCents: sql<number>`${input.feeCents}`.as("fee_cents"),
        // From the selected row: no surviving row means nothing to point the evidence FK at.
        recoveredPaymentId: recoveredPayments.id,
        disputeId: sql<string | null>`null`.as("dispute_id"),
        adminAuditLogId: sql<string | null>`null`.as("admin_audit_log_id"),
        description: sql<string>`${input.description}`.as("description"),
        createdAt: sql<number>`${input.createdAt.getTime()}`.as("created_at"),
        // Both null, but drizzle's insert-select requires every column; an omission is a runtime error.
        stripeCreditNoteId: sql<string | null>`null`.as("stripe_credit_note_id"),
        creditsLineItemId: sql<string | null>`null`.as("credits_line_item_id"),
        refundedCents: recoveredPayments.refundedCents,
      })
      .from(recoveredPayments)
      .where(
        and(
          eq(recoveredPayments.id, input.recoveredPaymentId),
          eq(recoveredPayments.refundedCents, input.refundedCents),
          billableRecoveryRowConditions(input.accountId, input.asOfMs),
          exemptionForgaveRecovery(input.asOfMs),
          // The account gate every read applies: a pause or exemption landing after the read stops the line.
          exists(
            qb
              .select({ one: sql`1` })
              .from(accounts)
              .where(
                and(
                  eq(accounts.id, recoveredPayments.accountId),
                  accountBillingEligibleCondition(),
                ),
              ),
          ),
        ),
      ),
  );
}

/** Set an invoice's total from the line items that ACTUALLY COMMITTED, in the same batch; a JS total from the pre-write list would overstate a withdrawn fee. */
export function buildInvoiceTotalFromLines(db: Db, invoiceId: string) {
  return db
    .update(billingInvoices)
    .set({
      totalCents: sql<number>`(select coalesce(sum(${billingLineItems.amountCents}), 0) from ${billingLineItems} where ${billingLineItems.invoiceId} = ${invoiceId})`,
    })
    .where(eq(billingInvoices.id, invoiceId));
}
