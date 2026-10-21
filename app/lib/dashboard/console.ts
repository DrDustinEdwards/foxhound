// Pure console-cluster logic: the phrases and predicates the hero row, product
// tiles, and needs-attention feed are built from.
//
// Separate from console.server.ts for two reasons. It is unit-testable without a
// DB or a Durable Object, mirroring the existing recovery-window.ts /
// recovery-window.server.ts split. And the components need some of these at
// render time: a VALUE import from a *.server.ts module inside a component body
// passes typecheck and fails the client build, so anything a component calls has
// to live here.

import { formatMoneyShort } from "~/lib/money-format";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead a dispute deadline counts as urgent, matching legacy's
 *  DISPUTE_URGENT_HOURS. A console presentation threshold, not an engine
 *  parameter, which is why it is not in app/lib/constants.ts. */
export const DISPUTE_URGENT_HOURS = 48;

/** How far ahead a card expiry surfaces in the feed. */
const EXPIRING_CARD_WINDOW_DAYS = 7;

/** Rows shown per attention category before collapsing into "and N more". */
export const ATTENTION_ROWS_PER_CATEGORY = 3;

/** Disputes-due rows shown. Legacy allowed 5 here against 3 elsewhere, because a
 *  deadline is the only item on this feed with a hard external clock. */
export const DISPUTE_ATTENTION_LIMIT = 5;

/**
 * Deadline phrase for the attention feed. A past deadline stays surfaced and
 * reads "overdue" rather than disappearing, because the merchant may still be
 * able to submit and hiding it would be the worse failure.
 */
export function deadlinePhrase(deadline: Date, nowMs: number): string {
  const ms = deadline.getTime() - nowMs;
  if (ms < 0) return "overdue";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "within the hour";
  if (hours < 24) return `in ${hours}h`;
  return "tomorrow";
}

/** Expiry phrase for an expiring-card row, from the card's final valid day. */
export function expiryPhrase(expiresAt: Date, nowMs: number): string {
  const days = Math.ceil((expiresAt.getTime() - nowMs) / DAY_MS);
  if (days <= 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

/**
 * Last day of a card's expiry month. A card is valid through the END of that
 * month, and JS months are 0-indexed, so passing the 1-based month with day 0
 * lands on the last day of that same month.
 */
export function cardExpiryDate(expiresMonth: number, expiresYear: number): Date {
  return new Date(Date.UTC(expiresYear, expiresMonth, 0));
}

/** "Last run today" / "yesterday" / "N days ago" for the Audit tile. */
export function lastRunPhrase(runAt: Date, nowMs: number): string {
  const days = Math.floor((nowMs - runAt.getTime()) / DAY_MS);
  if (days <= 0) return "Last run today";
  if (days === 1) return "Last run yesterday";
  return `Last run ${days} days ago`;
}

/**
 * A failed payment's sequence is "exhausted" when the payment is still active
 * but has no future unexecuted step left: the sequence ran to the end without
 * recovering it, so nothing further happens without a human. That is precisely
 * the thing worth surfacing, and it is invisible from the payment's status alone.
 */
export function isSequenceExhausted(
  steps: { scheduledAt: Date; executedAt: Date | null; result: string | null }[],
  nowMs: number,
): boolean {
  return !steps.some(
    (s) => s.executedAt === null && s.result === null && s.scheduledAt.getTime() > nowMs,
  );
}

/** The "N active sequences · N open disputes" subtext, or "All clear". */
export function atRiskSubtext(activeSequenceCount: number, openDisputeCount: number): string {
  const parts: string[] = [];
  if (activeSequenceCount > 0) {
    parts.push(`${activeSequenceCount} active ${activeSequenceCount === 1 ? "sequence" : "sequences"}`);
  }
  if (openDisputeCount > 0) {
    parts.push(`${openDisputeCount} open ${openDisputeCount === 1 ? "dispute" : "disputes"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "All clear";
}

/** The all-time recovery count subtext under the protected figure. */
export function protectedSubtext(recoveredAllTimeCount: number): string {
  if (recoveredAllTimeCount === 0) return "No recoveries yet";
  return `${recoveredAllTimeCount} ${recoveredAllTimeCount === 1 ? "payment" : "payments"} recovered all time`;
}

/** Whether a card's expiry falls inside the feed's window. A card that expired
 *  weeks ago is history, not an action, so the window has a floor too. */
export function isCardInAttentionWindow(expiresAt: Date, nowMs: number): boolean {
  const end = nowMs + EXPIRING_CARD_WINDOW_DAYS * DAY_MS;
  return expiresAt.getTime() <= end && expiresAt.getTime() >= nowMs - DAY_MS;
}

/**
 * Each currency's total in Recova's short format (formatAmountShort: whole
 * units), joined with " · ". A total is never summed across currencies
 * (RULES.md 3.20), so an account paid in two currencies sees both. Nothing at
 * all reads as Recova's zero, "$0".
 */
export function formatCurrencyTotalsShort(rows: readonly { currency: string; cents: number }[]): string {
  if (rows.length === 0) return formatMoneyShort(0, "usd");
  return rows.map((r) => formatMoneyShort(r.cents, r.currency)).join(" · ");
}

/** The latest month's five MRR movements, in the console chart's order. */
export interface MovementTotals {
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
  reactivationMrrCents: number;
}

/** The movement bars as rows in whole currency units, the values the chart
 *  draws: contraction and churn below zero. */
export function mrrMovementBars(m: MovementTotals): { label: string; units: number }[] {
  const units = (cents: number) => Math.round(cents / 100);
  return [
    { label: "New", units: units(m.newMrrCents) },
    { label: "Expand", units: units(m.expansionMrrCents) },
    { label: "Contract", units: units(-m.contractionMrrCents) },
    { label: "Churn", units: units(-m.churnMrrCents) },
    { label: "Reactivate", units: units(m.reactivationMrrCents) },
  ];
}

/** The movement chart's text equivalent, built from the same whole units the
 *  bars and the data table show, so the three never disagree. */
export function mrrMovementAlt(m: MovementTotals, currency: string): string {
  const parts = mrrMovementBars(m).map((b) => `${b.label} ${formatMoneyShort(b.units * 100, currency)}`);
  return `MRR movements in the latest month: ${parts.join(", ")}.`;
}

/**
 * Whether the monthly intelligence-sync will write this account an MRR
 * snapshot: it writes nothing without a Stripe connection
 * (runIntelligenceSyncForAccount) and skips paused and cancelled accounts
 * (accountProcessingEligible).
 */
export type MrrSyncState = "eligible" | "unconnected" | "paused" | "cancelled";

/** The empty MRR state's sentence, true for each sync state. Only an eligible
 *  account is promised a snapshot date. */
export function mrrEmptySentence(state: MrrSyncState, firstSnapshot: string): string {
  switch (state) {
    case "eligible":
      return firstSnapshot;
    case "unconnected":
      return "MRR analytics start once Stripe is connected. Foxhound takes the first snapshot on its monthly run after that.";
    case "paused":
      return "Processing is paused for this account, so Foxhound is not taking MRR snapshots.";
    case "cancelled":
      return "This account is cancelled, so Foxhound takes no MRR snapshots.";
  }
}
