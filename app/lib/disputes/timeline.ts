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
import { humanizeDisputeReason } from "./labels";

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
}

export interface DisputeTimelineItem {
  /** Null when the event is known to have happened but carries no timestamp. */
  at: Date | null;
  label: string;
}

/** Who submitted the evidence, in Recova's words (components/disputes/
 *  timeline.ts, blob 04fbe976). Foxhound stores the approver's email for its
 *  own submissions, so anything but the external marker is Foxhound. */
function submitterPhrase(submittedBy: string | null): string {
  if (submittedBy === "merchant_or_stripe") return "externally (merchant or Stripe)";
  return "Foxhound";
}

/**
 * The ordered event list for one dispute. Events with a timestamp sort by it;
 * an event whose timestamp is null keeps its position relative to the events
 * around it rather than collapsing to the top.
 */
export function buildDisputeTimeline(d: DisputeTimelineInput): DisputeTimelineItem[] {
  const items: DisputeTimelineItem[] = [
    {
      at: d.createdAt,
      label: `Dispute received. ${formatMoney(d.amountCents, d.currency)} for ${humanizeDisputeReason(d.reason)}.`,
    },
  ];

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
