// The dispute timeline: what happened to this chargeback, in order.
//
// Legacy built the same five events but appended them in source order and never
// sorted, so a backfilled staged_at landing after submitted_at rendered out of
// sequence. It also gave the terminal ruling the SAME timestamp as the outcome
// notification, so "Outcome notification sent" and "Bank ruled: WON" always
// printed identical times, and it emitted no terminal event at all for an
// accepted dispute. This sorts, and it separates the ruling from the
// notification by using resolved_at for the ruling.

import { formatMoney } from "~/lib/money-format";
import { humanizeDisputeReason, isInquiryStatus, SUBMITTED_AUTOMATICALLY, SUBMITTED_EXTERNALLY } from "./labels";

/** One balance transaction Stripe recorded for the dispute
 *  (dispute_balance_transactions), signed as Stripe signs it. */
export interface DisputeFundsEntry {
  kind: string;
  amountCents: number;
  feeCents: number;
  currency: string;
  occurredAt: Date;
}

export interface DisputeTimelineInput {
  createdAt: Date;
  amountCents: number;
  currency: string;
  reason: string | null;
  aiGeneratedAt: Date | null;
  stagedAt: Date | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  outcomeNotifiedAt: Date | null;
  resolvedAt: Date | null;
  state: string;
  /** Stripe's dispute status; a warning_* status makes this an inquiry. */
  status?: string | null;
  /** Money Stripe withdrew and reinstated for this dispute. */
  funds?: readonly DisputeFundsEntry[];
}

export interface DisputeTimelineItem {
  /** Null when the event is known to have happened but carries no timestamp. */
  at: Date | null;
  label: string;
}

/** Who submitted the evidence, in Recova's words (components/disputes/
 *  timeline.ts, blob 04fbe976). Foxhound stores the approver's email for its
 *  own manual submissions, so anything but the two markers is Foxhound. */
function submitterPhrase(submittedBy: string | null): string {
  if (submittedBy === SUBMITTED_EXTERNALLY) return "externally (merchant or Stripe)";
  if (submittedBy === SUBMITTED_AUTOMATICALLY) return "Foxhound (auto-submit)";
  return "Foxhound";
}

/** A funds entry in words: the amount moved and Stripe's own dispute fee, each
 *  in the balance transaction's currency. A fee Stripe returned is negative. */
function fundsLabel(f: DisputeFundsEntry): string {
  const amount = formatMoney(Math.abs(f.amountCents), f.currency);
  const fee = formatMoney(Math.abs(f.feeCents), f.currency);
  if (f.kind === "withdrawn") {
    return f.feeCents > 0
      ? `Funds withdrawn by Stripe: ${amount}, plus a ${fee} Stripe dispute fee.`
      : `Funds withdrawn by Stripe: ${amount}.`;
  }
  if (f.feeCents < 0) return `Funds reinstated by Stripe: ${amount}, and the ${fee} Stripe dispute fee returned.`;
  if (f.feeCents > 0) return `Funds reinstated by Stripe: ${amount}, less a ${fee} Stripe fee.`;
  return `Funds reinstated by Stripe: ${amount}.`;
}

/**
 * The ordered event list for one dispute. Events with a timestamp sort by it;
 * an event whose timestamp is null keeps its position relative to the events
 * around it rather than collapsing to the top.
 */
export function buildDisputeTimeline(d: DisputeTimelineInput): DisputeTimelineItem[] {
  const inquiry = d.state === "inquiry_closed" || isInquiryStatus(d.status);
  const items: DisputeTimelineItem[] = [
    {
      at: d.createdAt,
      label: `${inquiry ? "Inquiry" : "Dispute"} received. ${formatMoney(d.amountCents, d.currency)} for ${humanizeDisputeReason(d.reason)}.`,
    },
  ];
  for (const f of d.funds ?? []) {
    items.push({ at: f.occurredAt, label: fundsLabel(f) });
  }

  if (d.aiGeneratedAt) {
    items.push({ at: d.aiGeneratedAt, label: "Foxhound drafted evidence from your records." });
  }
  if (d.stagedAt) {
    items.push({ at: d.stagedAt, label: "Evidence staged for your review." });
  }
  if (d.submittedAt) {
    items.push({
      at: d.submittedAt,
      label: `Evidence submitted to bank by ${submitterPhrase(d.submittedBy)}.`,
    });
  }
  if (d.outcomeNotifiedAt) {
    items.push({ at: d.outcomeNotifiedAt, label: "Outcome notification sent." });
  }

  // The ruling is anchored to resolved_at, not to the notification timestamp, so
  // the two events do not print the same time. The words are Recova's; the fee
  // a win carries is stated on the page's approval card, not here.
  if (d.state === "resolved_won") {
    items.push({ at: d.resolvedAt, label: "Bank ruled: WON. Funds retained." });
  } else if (d.state === "resolved_lost") {
    items.push({ at: d.resolvedAt, label: "Bank ruled: LOST. Funds deducted." });
  } else if (d.state === "inquiry_closed") {
    items.push({ at: d.resolvedAt, label: "Inquiry closed with no chargeback ruling." });
  }

  // Stable sort on the timestamp, leaving null-timestamped events where they
  // were. Array.prototype.sort is stable in every runtime this ships to.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const at = a.item.at?.getTime();
      const bt = b.item.at?.getTime();
      if (at === undefined || bt === undefined) return a.index - b.index;
      if (at === bt) return a.index - b.index;
      return at - bt;
    })
    .map((x) => x.item);
}
