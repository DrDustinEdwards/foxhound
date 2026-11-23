// The dispute timeline: what happened to this chargeback, in order.

import { formatMoney } from "@dustinedwards/site-runtime/money";
import {
  humanizeDisputeReason,
  isInquiryStatus,
  SUBMITTED_AUTOMATICALLY,
  SUBMITTED_EXTERNALLY,
} from "./labels";

/**
 * One balance transaction Stripe recorded for the dispute
 * (dispute_balance_transactions), signed as Stripe signs it.
 */
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

function submitterPhrase(submittedBy: string | null): string {
  if (submittedBy === SUBMITTED_EXTERNALLY) return "externally (merchant or Stripe)";
  if (submittedBy === SUBMITTED_AUTOMATICALLY) return "Foxhound (auto-submit)";
  return "Foxhound";
}

/**
 * A funds entry in words: the amount moved and Stripe's own dispute fee, each
 * in the balance transaction's currency. A fee Stripe returned is negative.
 */
function fundsLabel(f: DisputeFundsEntry): string {
  const amount = formatMoney(Math.abs(f.amountCents), f.currency);
  const fee = formatMoney(Math.abs(f.feeCents), f.currency);
  if (f.kind === "withdrawn") {
    return f.feeCents > 0
      ? `Funds withdrawn by Stripe: ${amount}, plus a ${fee} Stripe dispute fee.`
      : `Funds withdrawn by Stripe: ${amount}.`;
  }
  if (f.feeCents < 0)
    return `Funds reinstated by Stripe: ${amount}, and the ${fee} Stripe dispute fee returned.`;
  if (f.feeCents > 0) return `Funds reinstated by Stripe: ${amount}, less a ${fee} Stripe fee.`;
  return `Funds reinstated by Stripe: ${amount}.`;
}

/**
 * The ordered event list for one dispute. Events with a timestamp sort by it;
 * an event whose timestamp is null follows the event built just before it.
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

  // The ruling is anchored to resolved_at, not to the notification timestamp,
  // so the two events do not print the same time.
  if (d.state === "resolved_won") {
    items.push({ at: d.resolvedAt, label: "Bank ruled: WON. Funds retained." });
  } else if (d.state === "resolved_lost") {
    items.push({ at: d.resolvedAt, label: "Bank ruled: LOST. Funds deducted." });
  } else if (d.state === "inquiry_closed") {
    items.push({ at: d.resolvedAt, label: "Inquiry closed with no chargeback ruling." });
  }

  // Dated events sort by time (stable); an undated one is placed after the event that preceded it in the
  // order built above, so a null timestamp never makes the comparator inconsistent.
  const out = items.filter((i) => i.at).sort((a, b) => a.at!.getTime() - b.at!.getTime());
  items.forEach((item, index) => {
    if (item.at) return;
    out.splice(out.indexOf(items[index - 1]) + 1, 0, item);
  });
  return out;
}
