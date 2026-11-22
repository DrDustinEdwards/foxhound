// Real-time subscription changes for Intelligence, so the merchant hears the same day, not after the next daily
// sync. Pure: the webhook classifier (app/lib/webhooks/events.ts) reads what changed off a
// customer.subscription.updated event's previous_attributes with no Stripe call; the scorer (risk.ts) reads the
// rows back as one state per customer. The daily sync stays the source of truth for MRR and plan; these rows are
// a separate event log (subscription_changes), never a write to the columns the sync owns.

import { DAY_MS } from "~/lib/constants";

import { monthlyEquivalentCents, type BillingInterval } from "./signals";
import { stripeDate } from "~/lib/stripe/time";

type SubscriptionChangeKind =
  | "cancel_scheduled"
  | "cancel_reversed"
  | "paused"
  | "resumed"
  | "downgraded";

export interface SubscriptionChange {
  kind: SubscriptionChangeKind;
  cancelAt: Date | null;
  resumesAt: Date | null;
  previousMrrCents: number | null;
  currentMrrCents: number | null;
}

interface ItemLike {
  quantity?: number | null;
  current_period_end?: number | null;
  price?: {
    unit_amount?: number | null;
    recurring?: { interval?: string | null; interval_count?: number | null } | null;
  } | null;
}

export interface SubscriptionLike {
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  pause_collection?: { resumes_at?: number | null } | null;
  items?: { data?: ItemLike[] | null } | null;
}

function interval(item: ItemLike): BillingInterval {
  const i = item.price?.recurring?.interval;
  return i === "day" || i === "week" || i === "year" ? i : "month";
}

/** The items' monthly-equivalent total, the same normalization as the daily sync's MRR (signals.ts). */
function itemsMrrCents(items: ItemLike[]): number {
  return items.reduce(
    (sum, item) =>
      sum +
      monthlyEquivalentCents(
        item.price?.unit_amount ?? 0,
        item.quantity ?? 1,
        interval(item),
        item.price?.recurring?.interval_count ?? 1,
      ),
    0,
  );
}

function scheduled(
  cancelAtPeriodEnd: boolean | null | undefined,
  cancelAt: number | null | undefined,
): boolean {
  return cancelAtPeriodEnd === true || (cancelAt ?? null) !== null;
}

/** When a scheduled cancellation takes effect: cancel_at, or for cancel_at_period_end the latest item period end
 *  (on the pinned API version the period lives on the item). Null when neither is on the event. */
function cancelDate(sub: SubscriptionLike): Date | null {
  if (sub.cancel_at) return stripeDate(sub.cancel_at);
  const ends = (sub.items?.data ?? []).map((i) => i.current_period_end ?? 0).filter((n) => n > 0);
  return ends.length > 0 ? stripeDate(Math.max(...ends)) : null;
}

/** What one customer.subscription.updated changed that Intelligence tracks: a cancellation scheduled or taken
 *  back, collection paused or resumed, a drop in monthly-equivalent amount. Only fields in previous_attributes
 *  count, so an unrelated update records nothing. Pure. */
export function detectSubscriptionChanges(
  sub: SubscriptionLike,
  previous: Record<string, unknown> | null | undefined,
): SubscriptionChange[] {
  const prev = (previous ?? {}) as SubscriptionLike & Record<string, unknown>;
  const changes: SubscriptionChange[] = [];
  const blank = { cancelAt: null, resumesAt: null, previousMrrCents: null, currentMrrCents: null };

  if ("cancel_at_period_end" in prev || "cancel_at" in prev) {
    const now = scheduled(sub.cancel_at_period_end, sub.cancel_at);
    const was = scheduled(
      "cancel_at_period_end" in prev ? prev.cancel_at_period_end : sub.cancel_at_period_end,
      "cancel_at" in prev ? prev.cancel_at : sub.cancel_at,
    );
    // A moved date on an already-scheduled cancellation is recorded again so the latest row carries the new date.
    if (now) changes.push({ ...blank, kind: "cancel_scheduled", cancelAt: cancelDate(sub) });
    else if (was) changes.push({ ...blank, kind: "cancel_reversed" });
  }

  if ("pause_collection" in prev) {
    const now = (sub.pause_collection ?? null) !== null;
    const was = (prev.pause_collection ?? null) !== null;
    if (now)
      changes.push({
        ...blank,
        kind: "paused",
        resumesAt: stripeDate(sub.pause_collection?.resumes_at),
      });
    else if (was) changes.push({ ...blank, kind: "resumed" });
  }

  const prevItems = prev.items?.data;
  if (Array.isArray(prevItems)) {
    const previousMrrCents = itemsMrrCents(prevItems);
    const currentMrrCents = itemsMrrCents(sub.items?.data ?? []);
    if (currentMrrCents < previousMrrCents) {
      changes.push({ ...blank, kind: "downgraded", previousMrrCents, currentMrrCents });
    }
  }
  return changes;
}

export interface SubscriptionChangeRow {
  stripeSubscriptionId: string;
  kind: string;
  cancelAt: Date | null;
  resumesAt: Date | null;
  occurredAt: Date;
}

export interface SubscriptionChangeState {
  /** The earliest pending cancellation date (null date when the event carried none). Undefined when none. */
  cancellationPending: { at: Date | null } | undefined;
  pausePending: { resumesAt: Date | null } | undefined;
  recentDowngradeAt: Date | null;
}

/** How long a downgrade counts against the score: one quarter; after that the daily sync's plan change count carries it. */
const DOWNGRADE_WINDOW_DAYS = 90;

/** Folds a customer's recorded changes into what is true now. Per subscription the latest cancel row and latest
 *  pause row win, so a reversal clears an earlier scheduling; a cancellation or pause whose date has passed is no
 *  longer pending. Null when nothing is pending or recent. Pure. */
export function summarizeSubscriptionChanges(
  rows: SubscriptionChangeRow[],
  nowMs: number,
): SubscriptionChangeState | null {
  const latest = new Map<string, SubscriptionChangeRow>();
  let recentDowngradeAt: Date | null = null;
  for (const row of rows) {
    if (row.kind === "downgraded") {
      if (nowMs - row.occurredAt.getTime() <= DOWNGRADE_WINDOW_DAYS * DAY_MS) {
        if (!recentDowngradeAt || row.occurredAt > recentDowngradeAt)
          recentDowngradeAt = row.occurredAt;
      }
      continue;
    }
    const family =
      row.kind === "cancel_scheduled" || row.kind === "cancel_reversed" ? "cancel" : "pause";
    const key = `${row.stripeSubscriptionId}:${family}`;
    const seen = latest.get(key);
    if (!seen || row.occurredAt >= seen.occurredAt) latest.set(key, row);
  }

  let cancellationPending: SubscriptionChangeState["cancellationPending"];
  let pausePending: SubscriptionChangeState["pausePending"];
  for (const row of latest.values()) {
    if (row.kind === "cancel_scheduled" && (!row.cancelAt || row.cancelAt.getTime() > nowMs)) {
      const at = row.cancelAt;
      if (
        !cancellationPending ||
        (at && (!cancellationPending.at || at < cancellationPending.at))
      ) {
        cancellationPending = { at };
      }
    }
    if (row.kind === "paused" && (!row.resumesAt || row.resumesAt.getTime() > nowMs)) {
      pausePending = { resumesAt: row.resumesAt };
    }
  }

  if (!cancellationPending && !pausePending && !recentDowngradeAt) return null;
  return { cancellationPending, pausePending, recentDowngradeAt };
}
