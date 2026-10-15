// Summary stats for the /disputes stat cards (J66, row S13). Pure: the route
// hands it the rows it already loaded, so no extra query.
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
//   difference (question 4), because /features (J60) cites it.
//
// Money is returned as per-currency parts, never summed here: a total across
// currencies is meaningless, and every money total goes through
// groupSumByCurrency (RULES.md 3.20), which the loader applies.

import { SUBMITTED_EXTERNALLY, isDisputeResolved } from "./labels";

export interface DisputeStatsInput {
  state: string;
  amountCents: number;
  currency: string;
  submittedAt: Date | null;
  submittedBy: string | null;
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
   * Every dispute whose evidence Foxhound submitted, in any state, lifetime
   * (Recova's card is a lifetime count too). submitted_at is written only once
   * Stripe has accepted a Foxhound submission (approval.server.ts), and a
   * stored submitted_by of merchant_or_stripe says someone else sent it.
   */
  submittedByFoxhoundCount: number;
  wonCount: number;
  lostCount: number;
  /** Won as a share of resolved disputes, or null when nothing has resolved:
   *  a 0% win rate and "nothing resolved yet" are different claims. */
  winRatePct: number | null;
}

export function computeDisputeStats(rows: DisputeStatsInput[]): DisputeStats {
  let openCount = 0;
  const atStakeParts: MoneyPart[] = [];
  let submittedByFoxhoundCount = 0;
  let wonCount = 0;
  let lostCount = 0;

  for (const row of rows) {
    if (row.submittedAt && row.submittedBy !== SUBMITTED_EXTERNALLY) submittedByFoxhoundCount++;
    if (!isDisputeResolved(row.state)) {
      openCount++;
      atStakeParts.push({ currency: row.currency, cents: row.amountCents });
    } else if (row.state === "resolved_won") {
      wonCount++;
    } else if (row.state === "resolved_lost") {
      lostCount++;
    }
  }

  const resolvedCount = wonCount + lostCount;
  return {
    openCount,
    atStakeParts,
    submittedByFoxhoundCount,
    wonCount,
    lostCount,
    winRatePct: resolvedCount > 0 ? Math.round((wonCount / resolvedCount) * 100) : null,
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
