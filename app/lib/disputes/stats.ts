// Summary stats for the /disputes header cards. Pure: the route hands it the
// rows it already loaded, so no extra query.
//
// Legacy had five cards here and one of them was wrong in four separate ways.
// Its "saved vs Stripe" card computed `round(amount * 0.10)` from a hardcoded
// literal, on the claim that Foxhound charges 20% where Stripe's alternative
// costs 30%. Under Foxhound pricing that formula is not just stale, it is
// structurally wrong: the real fee is min(20%, $500 cap), so on a won $10,000
// dispute the card understated the merchant's saving by $1,500. It also filtered
// on `outcome` while every neighbouring stat filtered on `status`, and it
// re-derived Foxhound's own fee instead of reading the fee already stored on the
// record.
//
// So that card is deliberately not ported. What replaces it is the number the
// billing engine will actually invoice, taken from disputeFeeCents (the single
// source of truth for fee math, cap included) or from resolved_fee_cents once
// resolution has stamped it. Nothing here re-inlines a percentage.

import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { disputeFeeCents } from "~/lib/billing/fees";
import { isDisputeResolved } from "./labels";

export interface DisputeStatsInput {
  state: string;
  amountCents: number;
  resolvedFeeCents: number | null;
  submittedAt: Date | null;
}

export interface DisputeStats {
  /** Disputes still awaiting a Foxhound or merchant action. */
  needsActionCount: number;
  /** Total disputed amount across those, the money actually in play. */
  atStakeCents: number;
  wonCount: number;
  lostCount: number;
  /**
   * Won as a share of RESOLVED disputes, or null when nothing has resolved yet.
   * Null rather than 0 because a 0% win rate and "no dispute has resolved" are
   * different claims and the second must not read as the first.
   */
  winRatePct: number | null;
  /**
   * Fees owed on won disputes Foxhound actually submitted. Uses the stored
   * resolved_fee_cents where resolution has written it, else the capped
   * projection from disputeFeeCents.
   */
  feesOwedCents: number;
}

/** True when the dispute is still in play: not resolved either way. */
function isNeedsAction(state: string): boolean {
  return !isDisputeResolved(state);
}

export function computeDisputeStats(rows: DisputeStatsInput[]): DisputeStats {
  let needsActionCount = 0;
  let atStakeCents = 0;
  let wonCount = 0;
  let lostCount = 0;
  let feesOwedCents = 0;

  for (const row of rows) {
    if (isNeedsAction(row.state)) {
      needsActionCount++;
      atStakeCents += row.amountCents;
      continue;
    }
    if (row.state === "resolved_lost") {
      lostCount++;
      continue;
    }
    if (row.state !== "resolved_won") continue;
    wonCount++;
    // PRICING.md rev 3: billable only when Foxhound drafted AND submitted the
    // evidence. A merchant-fought or auto-resolved win is a win with no fee, so
    // it must not land in this total.
    if (!row.submittedAt) continue;
    feesOwedCents += row.resolvedFeeCents ?? disputeFeeCents(row.amountCents, DISPUTE_FEE_CAP_CENTS);
  }

  const resolvedCount = wonCount + lostCount;
  return {
    needsActionCount,
    atStakeCents,
    wonCount,
    lostCount,
    winRatePct: resolvedCount > 0 ? Math.round((wonCount / resolvedCount) * 100) : null,
    feesOwedCents,
  };
}
