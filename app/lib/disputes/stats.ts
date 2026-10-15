// Summary stats for the /disputes stat cards (J66, row S13). Pure: the route
// hands it the rows it already loaded, so no extra query.
//
// Recova's view (app/(app)/disputes/dashboard/DisputesDashboardView.tsx, blob
// 3c1b7a98) has five cards: Open disputes, At stake, Submitted by Recova, Fees
// owed and Saved vs Smart Disputes. Two are held for Dustin and not computed
// here (TASK-seven-walked-pages.md item 6 (b)): "Submitted by" and "Saved vs
// Smart Disputes", the second a claim about Stripe's price with no source.
// Recova's saving was round(amount * 0.10) from a hardcoded literal; under
// Foxhound's pricing the real fee is min(20%, $500 cap), so that formula is
// structurally wrong, and nothing here re-inlines a percentage.
//
// Win rate is not one of Recova's cards. It stays because Foxhound's /features
// page (J60, from Recova's features-data.ts, which claims a "historical win
// rate" here) names this card as its evidence; whether the card goes and
// /features changes with it is a question for Dustin in the J66 pull request.
//
// Money is returned as per-currency parts, never summed here: a total across
// currencies is meaningless, and every money total goes through
// groupSumByCurrency (RULES.md 3.20), which the loader applies.

import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { disputeFeeCents } from "~/lib/billing/fees";
import { isDisputeResolved } from "./labels";

export interface DisputeStatsInput {
  state: string;
  amountCents: number;
  currency: string;
  resolvedFeeCents: number | null;
  resolvedFeeCurrency: string | null;
  submittedAt: Date | null;
}

export interface MoneyPart {
  currency: string;
  cents: number;
}

export interface DisputeStats {
  /** Disputes not yet resolved either way. */
  openCount: number;
  /** The disputed amount of each open dispute, in its own currency. */
  atStakeParts: MoneyPart[];
  /**
   * The fee on each won dispute Foxhound submitted: the stored
   * resolved_fee_cents in its stored currency where resolution has written it,
   * else the capped projection from disputeFeeCents in the dispute's currency.
   */
  feesOwedParts: MoneyPart[];
  wonCount: number;
  lostCount: number;
  /** Won as a share of resolved disputes, or null when nothing has resolved:
   *  a 0% win rate and "nothing resolved yet" are different claims. */
  winRatePct: number | null;
}

export function computeDisputeStats(rows: DisputeStatsInput[]): DisputeStats {
  let openCount = 0;
  const atStakeParts: MoneyPart[] = [];
  const feesOwedParts: MoneyPart[] = [];
  let wonCount = 0;
  let lostCount = 0;

  for (const row of rows) {
    if (!isDisputeResolved(row.state)) {
      openCount++;
      atStakeParts.push({ currency: row.currency, cents: row.amountCents });
      continue;
    }
    if (row.state === "resolved_lost") {
      lostCount++;
      continue;
    }
    if (row.state !== "resolved_won") continue;
    wonCount++;
    // PRICING.md rev 3: billable only when Foxhound drafted AND submitted the
    // evidence. A merchant-fought or auto-resolved win carries no fee.
    if (!row.submittedAt) continue;
    if (row.resolvedFeeCents !== null) {
      feesOwedParts.push({ currency: row.resolvedFeeCurrency ?? row.currency, cents: row.resolvedFeeCents });
    } else {
      feesOwedParts.push({ currency: row.currency, cents: disputeFeeCents(row.amountCents, DISPUTE_FEE_CAP_CENTS) });
    }
  }

  const resolvedCount = wonCount + lostCount;
  return {
    openCount,
    atStakeParts,
    feesOwedParts,
    wonCount,
    lostCount,
    winRatePct: resolvedCount > 0 ? Math.round((wonCount / resolvedCount) * 100) : null,
  };
}
