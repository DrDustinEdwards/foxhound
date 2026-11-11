// Summary stats for the /disputes stat cards. Pure: /disputes hands it the
// account's disputes grouped in SQL (disputeStatGroups), the preview and the
// audit figures their own rows.
//
// Recova's view (app/(app)/disputes/dashboard/DisputesDashboardView.tsx, blob
// 3c1b7a98) has five cards: Open disputes, At stake, Submitted by Recova, Fees
// owed and Saved vs Smart Disputes. Dustin answered PR #75's questions "yes ro
// all" (2026-10-15, cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6):
//
// - "Submitted by Foxhound" is built, from Foxhound's own data (below).
// - "Saved vs Smart Disputes" is not. Recova's saving was round(amount * 0.10)
//   from a hardcoded literal and an unsourced claim about Stripe's price; under
//   Foxhound's pricing the real fee is min(20%, the $500 cap), so the formula is
//   structurally wrong, and nothing here re-inlines a percentage.
// - "Fees owed" is read from the billing records, not computed here
//   (fees-owed.server.ts), so it counts only fees still owed, as Recova's does.
// - Win rate is not one of Recova's cards. It stays as Dustin's approved
//   difference (question 4), because /features cites it.
//
// Money is returned as per-currency parts, never summed here: a total across
// currencies is meaningless, and every money total goes through
// groupSumByCurrency, which the loader applies.

import type { CurrencyAmount } from "~/lib/money/totals";
import { SUBMITTED_EXTERNALLY, isDisputeResolved } from "./labels";
import { percent } from "capsomer/behavior/meter";

export interface DisputeStatsInput {
  state: string;
  amountCents: number;
  currency: string;
  submittedAt: Date | null;
  submittedBy: string | null;
}

export interface DisputeStats {
  /** Disputes not yet resolved either way. */
  openCount: number;
  /** The disputed amount of each open dispute, in its own currency. */
  atStakeParts: CurrencyAmount[];
  /** Every dispute whose evidence Foxhound submitted (submittedByFoxhound), in
   *  any state, lifetime (Recova's card is a lifetime count too). */
  submittedByFoxhoundCount: number;
  wonCount: number;
  lostCount: number;
  /** Won as a share of resolved disputes, or null when nothing has resolved:
   *  a 0% win rate and "nothing resolved yet" are different claims. */
  winRatePct: number | null;
}

/** Disputes alike for every card: one state and currency, submitted by
 *  Foxhound or not, with how many there are and their total amount. */
export interface DisputeStatGroup {
  state: string;
  currency: string;
  foxhoundSubmitted: boolean;
  count: number;
  amountCents: number;
}

/** Whether Foxhound sent the evidence. submitted_at is written only once
 *  Stripe has accepted a Foxhound submission (approval.server.ts), and a stored
 *  submitted_by of merchant_or_stripe says someone else sent it. */
export function submittedByFoxhound(row: Pick<DisputeStatsInput, "submittedAt" | "submittedBy">) {
  return row.submittedAt !== null && row.submittedBy !== SUBMITTED_EXTERNALLY;
}

export function computeDisputeStats(rows: DisputeStatsInput[]): DisputeStats {
  return computeDisputeStatsFromGroups(
    rows.map((row) => ({
      state: row.state,
      currency: row.currency,
      foxhoundSubmitted: submittedByFoxhound(row),
      count: 1,
      amountCents: row.amountCents,
    })),
  );
}

export function computeDisputeStatsFromGroups(groups: DisputeStatGroup[]): DisputeStats {
  let openCount = 0;
  const atStakeParts: CurrencyAmount[] = [];
  let submittedByFoxhoundCount = 0;
  let wonCount = 0;
  let lostCount = 0;

  for (const group of groups) {
    if (group.foxhoundSubmitted) submittedByFoxhoundCount += group.count;
    if (!isDisputeResolved(group.state)) {
      openCount += group.count;
      atStakeParts.push({ currency: group.currency, cents: group.amountCents });
    } else if (group.state === "resolved_won") {
      wonCount += group.count;
    } else if (group.state === "resolved_lost") {
      lostCount += group.count;
    }
  }

  const resolvedCount = wonCount + lostCount;
  return {
    openCount,
    atStakeParts,
    submittedByFoxhoundCount,
    wonCount,
    lostCount,
    winRatePct: resolvedCount > 0 ? percent(wonCount, resolvedCount) : null,
  };
}

/** The Win rate card's figure and line, as /disputes shows them (and the
 *  /product/disputes preview of that page): a dash and "No disputes resolved
 *  yet" until something resolves, never a 0%. */
export function winRateCard(stats: Pick<DisputeStats, "wonCount" | "lostCount" | "winRatePct">): {
  value: string;
  subtext: string;
} {
  if (stats.winRatePct === null) return { value: "-", subtext: "No disputes resolved yet" };
  return {
    value: `${stats.winRatePct}%`,
    subtext: `${stats.wonCount} won of ${stats.wonCount + stats.lostCount} resolved`,
  };
}
