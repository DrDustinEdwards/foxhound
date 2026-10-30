import { and, eq, gte, isNotNull, isNull, or } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { disputeBalanceTransactions, disputes, getDb } from "~/db";
import { getUnpricedBillableWins } from "~/db/billable";
import { resolveDisputeCap, type ResolvedDisputeCap } from "~/lib/billing/dispute-cap";
import { disputeFeeCents, feeForCurrency } from "~/lib/billing/fees";
import { executeMoneyWrite } from "~/lib/money/execute";

import { sendDisputeFeeNotice } from "./notices.server";

// THE PRICING RETRY for a won dispute whose fee could not be priced at
// resolution (Dustin, 2026-10-25, "Skip until priced").
//
// Resolution converts the USD 500 cap into the dispute's currency with a Stripe
// FX quote. When that quote fails the win resolves with no
// stored fee, and the billing run skips it (billableDisputeRowConditions). This
// is what prices it later: daily, before the monthly run on the 1st, every such
// win gets a fresh quote. A quote that works stores the fee exactly as the
// resolution writer would have, through the account's money Durable Object,
// and the merchant is sent the won notice again, now with its fee sentence, so
// the fee is told before the next run bills it. A quote that fails again
// changes nothing and is tried the next day.
//
// The rate is today's, not the resolution day's: the resolution day's rate is
// the one that could not be had. Its timestamp is stored with it, as at
// resolution.

/** How many unpriced wins one run prices. Each is one Stripe call and one
 *  money write; a backlog larger than this drains over the following days. */
const DISPUTE_FEE_PRICING_LIMIT = 50;

/** The stored fee for one unpriced win, conditioned on it still being unpriced,
 *  so a second writer that got there first makes this touch zero rows. */
function buildDisputeFeePricingUpdate(
  db: Db,
  input: { accountId: string; disputeId: string; amountCents: number; currency: string; cap: ResolvedDisputeCap },
): MoneyWriteBatch {
  return [
    db
      .update(disputes)
      .set({
        resolvedFeeCents: feeForCurrency(
          disputeFeeCents(input.amountCents, input.cap.capMinorUnits),
          input.currency,
        ),
        resolvedFeeCurrency: input.currency,
        resolvedFeeRate: input.cap.rate,
        resolvedFeeQuoteId: input.cap.quoteId,
        resolvedFeeRateAt: input.cap.quotedAt,
        resolvedFeeError: null,
      })
      .where(
        and(
          eq(disputes.id, input.disputeId),
          eq(disputes.accountId, input.accountId),
          eq(disputes.state, "resolved_won"),
          isNull(disputes.resolvedFeeCents),
        ),
      ),
  ];
}

export interface DisputeFeePricingResult {
  priced: number;
  failed: number;
  notified: number;
  errors: string[];
  /** Fees priced in the last day whose basis disagrees with what Stripe
   *  withdrew (checkPricedFeesAgainstStripe). Logged only. */
  mismatched: number;
}

const DAY_MS = 86_400_000;

/**
 * THE SELF-CHECK against what Stripe actually moved. A won dispute's fee is
 * priced on disputes.amount_cents; Stripe's charge.dispute.funds_withdrawn
 * balance transactions (dispute_balance_transactions, dispute-lifecycle.ts)
 * record the amount it really took from the merchant, and its own dispute fee.
 * For every win priced in the last day (resolved in it, or priced by this cron
 * in it), when Stripe's withdrawal is in the fee's currency and its amount
 * differs from the amount the fee was priced on, a structured warning is
 * logged. It changes no money and sends nothing: a mismatch is for a person to
 * read. A withdrawal in another (settlement) currency cannot be compared and is
 * skipped. Stripe's own dispute fee is carried in the log for context; it is
 * not Foxhound's fee and is never compared to it.
 */
export async function checkPricedFeesAgainstStripe(env: Env, now: Date): Promise<number> {
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await getDb(env)
    .select({
      id: disputes.id,
      accountId: disputes.accountId,
      stripeDisputeId: disputes.stripeDisputeId,
      pricedOnCents: disputes.amountCents,
      pricedFeeCents: disputes.resolvedFeeCents,
      feeCurrency: disputes.resolvedFeeCurrency,
      withdrawnCents: disputeBalanceTransactions.amountCents,
      stripeDisputeFeeCents: disputeBalanceTransactions.feeCents,
      withdrawnCurrency: disputeBalanceTransactions.currency,
    })
    .from(disputes)
    .innerJoin(
      disputeBalanceTransactions,
      and(
        eq(disputeBalanceTransactions.accountId, disputes.accountId),
        eq(disputeBalanceTransactions.stripeDisputeId, disputes.stripeDisputeId),
        eq(disputeBalanceTransactions.kind, "withdrawn"),
      ),
    )
    .where(
      and(
        eq(disputes.state, "resolved_won"),
        isNotNull(disputes.resolvedFeeCents),
        or(gte(disputes.resolvedAt, since), gte(disputes.resolvedFeeRateAt, since)),
      ),
    );

  // A dispute can carry more than one withdrawal; the check is on their total.
  const byDispute = new Map<string, (typeof rows)[number] & { withdrawnTotal: number; stripeFeeTotal: number }>();
  for (const row of rows) {
    if (row.withdrawnCurrency.toLowerCase() !== (row.feeCurrency ?? "").toLowerCase()) continue;
    const seen = byDispute.get(row.id);
    if (seen) {
      seen.withdrawnTotal += Math.abs(row.withdrawnCents);
      seen.stripeFeeTotal += row.stripeDisputeFeeCents;
    } else {
      byDispute.set(row.id, { ...row, withdrawnTotal: Math.abs(row.withdrawnCents), stripeFeeTotal: row.stripeDisputeFeeCents });
    }
  }

  let mismatched = 0;
  for (const d of byDispute.values()) {
    if (d.withdrawnTotal === d.pricedOnCents) continue;
    mismatched += 1;
    console.warn(
      JSON.stringify({
        event: "dispute_fee_stripe_mismatch",
        accountId: d.accountId,
        disputeId: d.id,
        stripeDisputeId: d.stripeDisputeId,
        currency: d.feeCurrency,
        pricedFeeCents: d.pricedFeeCents,
        pricedOnCents: d.pricedOnCents,
        stripeWithdrawnCents: d.withdrawnTotal,
        stripeDisputeFeeCents: d.stripeFeeTotal,
      }),
    );
  }
  return mismatched;
}

export async function priceUnpricedDisputeFees(
  env: Env,
  now: Date,
  cronRunId: string | null = null,
): Promise<DisputeFeePricingResult> {
  const wins = await getUnpricedBillableWins(getDb(env), now.getTime(), DISPUTE_FEE_PRICING_LIMIT);
  const result: DisputeFeePricingResult = { priced: 0, failed: 0, notified: 0, errors: [], mismatched: 0 };

  for (const win of wins) {
    let cap: ResolvedDisputeCap;
    try {
      cap = await resolveDisputeCap(env, win.currency, now);
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${win.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const { applied } = await executeMoneyWrite(env, {
      accountId: win.accountId,
      idempotencyKey: `dispute-fee-priced:${win.id}`,
      build: (db) =>
        buildDisputeFeePricingUpdate(db, {
          accountId: win.accountId,
          disputeId: win.id,
          amountCents: win.amountCents,
          currency: win.currency,
          cap,
        }),
    });
    if (!applied) continue;
    result.priced += 1;

    const notice = await sendDisputeFeeNotice(env, {
      accountId: win.accountId,
      disputeId: win.id,
      pricedAt: now,
      cronRunId,
    });
    if (notice.kind === "sent" && notice.result.status === "sent") result.notified += 1;
  }

  // After pricing, so a fee this run just stored is checked too. A failed
  // check must not fail the pricing it follows.
  try {
    result.mismatched = await checkPricedFeesAgainstStripe(env, now);
  } catch (err) {
    console.error("dispute fee stripe check failed:", err instanceof Error ? err.message : "unknown error");
  }

  return result;
}

/** The cron_run_history message. */
export function describeDisputeFeePricing(result: DisputeFeePricingResult): string {
  const base = `${result.priced} dispute fees priced, ${result.notified} merchants told, ${result.failed} still unpriced`;
  return result.mismatched > 0 ? `${base}, ${result.mismatched} disagree with Stripe's withdrawal` : base;
}

/** An alert while any win stays unpriced, so a quote that keeps failing is
 *  heard about rather than leaving a fee unbilled in silence. */
export function disputeFeePricingFailureError(result: DisputeFeePricingResult): string | null {
  if (result.failed === 0) return null;
  return `${result.failed} won dispute fee(s) could not be priced: ${result.errors.slice(0, 5).join("; ")}`;
}
