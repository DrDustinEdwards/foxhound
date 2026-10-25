import { and, eq, isNull } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { disputes, getDb } from "~/db";
import { getUnpricedBillableWins } from "~/db/billable";
import { resolveDisputeCap, type ResolvedDisputeCap } from "~/lib/billing/dispute-cap";
import { disputeFeeCents } from "~/lib/billing/fees";
import { executeMoneyWrite } from "~/lib/money/execute";

import { sendDisputeFeeNotice } from "./notices.server";

// THE PRICING RETRY for a won dispute whose fee could not be priced at
// resolution (Dustin, 2026-10-25, "Skip until priced"; job_a7020c40c211).
//
// Resolution converts the USD 500 cap into the dispute's currency with a Stripe
// FX quote (ruling 377(7)). When that quote fails the win resolves with no
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
export const DISPUTE_FEE_PRICING_LIMIT = 50;

/** The stored fee for one unpriced win, conditioned on it still being unpriced,
 *  so a second writer that got there first makes this touch zero rows. */
export function buildDisputeFeePricingUpdate(
  db: Db,
  input: { accountId: string; disputeId: string; amountCents: number; currency: string; cap: ResolvedDisputeCap },
): MoneyWriteBatch {
  return [
    db
      .update(disputes)
      .set({
        resolvedFeeCents: disputeFeeCents(input.amountCents, input.cap.capMinorUnits),
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
}

export async function priceUnpricedDisputeFees(
  env: Env,
  now: Date,
  cronRunId: string | null = null,
): Promise<DisputeFeePricingResult> {
  const wins = await getUnpricedBillableWins(getDb(env), now.getTime(), DISPUTE_FEE_PRICING_LIMIT);
  const result: DisputeFeePricingResult = { priced: 0, failed: 0, notified: 0, errors: [] };

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

  return result;
}

/** The cron_run_history message. */
export function describeDisputeFeePricing(result: DisputeFeePricingResult): string {
  return `${result.priced} dispute fees priced, ${result.notified} merchants told, ${result.failed} still unpriced`;
}

/** An alert while any win stays unpriced, so a quote that keeps failing is
 *  heard about rather than leaving a fee unbilled in silence. */
export function disputeFeePricingFailureError(result: DisputeFeePricingResult): string | null {
  if (result.failed === 0) return null;
  return `${result.failed} won dispute fee(s) could not be priced: ${result.errors.slice(0, 5).join("; ")}`;
}
