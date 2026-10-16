import { CRON_SCHEDULE_MONTHLY } from "~/lib/constants";
import { formatMoney } from "~/lib/money-format";

import { disputeFeeTerms } from "./detail";

// THE MERCHANT'S DISPUTE NOTICES (J06, job_4f4c9c2f5383): the words and the
// pure rules, no database and no send. Recova is the spec, read whole:
//   lib/disputes-email.ts                     blob 156719f1, 12,097 bytes
//   lib/dispute-handlers.ts                   blob e2bb8de8, 25,069 bytes
//   app/api/cron/process-disputes/route.ts    blob 1cbd5bd0, 21,298 bytes
//
// Four notices: a new dispute, a deadline reminder, a win and a loss. Recova's
// fifth, "Dispute response submitted", has no trigger here because Foxhound
// never auto-submits (RULES.md 5.6), so it is not built.
//
// WHAT IS NOT RECOVA'S, and why:
// - The triage line ("Recommendation: FIGHT (80/100) ...") is left out of the
//   new-dispute notice. Nothing in Foxhound writes a triage, and a line over
//   data nothing writes would be a guess (RULES.md 3.18).
// - Only Recova's auto-submit-OFF sentences are used, because auto-submit is
//   never on (RULES.md 5.6; the build plan's E16 and E17 entries say so).
// - The won notice's fee sentence states the fee the resolution writer
//   snapshotted (resolved_fee_cents, which carries the $500 cap) and Foxhound's
//   own terms read from the constants, not Recova's "20% of the saved amount",
//   which was untrue above the cap (RULES.md 1.2, 2.1).
// - Plain semantic HTML with the first line as the heading, as the recovery
//   notification does: Capsomer's email frame is the shell (RULES.md 3.16), and
//   Recova's button styles do not cross over.
// J92 and J93 bring the words the rest of the way to Recova's.

export const DISPUTE_CREATED_TEMPLATE = "merchant_dispute_created";
export const DISPUTE_REMINDER_TEMPLATE = "merchant_dispute_reminder";
export const DISPUTE_OUTCOME_TEMPLATE = "merchant_dispute_outcome";

/** The platform's From name, as on the recovery notification. Recova sent
 *  these from its own disputes address under the platform name. */
export const DISPUTE_NOTICE_FROM_NAME = "Foxhound";

/** Merchant data inside a notice is escaped: a customer name comes from Stripe
 *  and is not ours to trust. */
export function escapeNoticeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Recova's titleCaseReason: "product_not_received" to "Product Not Received". */
export function titleCaseReason(reason: string): string {
  return reason.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Recova's `customer_name || customer_email || 'Unknown customer'`. */
export function noticeCustomerLabel(name: string | null, email: string | null): string {
  return name || email || "Unknown customer";
}

export interface ReminderBucket {
  eventType: "dispute_reminder_3d" | "dispute_reminder_1d";
  daysLeft: 3 | 1;
}

/** The two bands, as hours before the evidence deadline. Recova's
 *  resolveReminderBucket, verbatim in its numbers. */
export const REMINDER_BANDS: readonly (ReminderBucket & { fromHours: number; toHours: number })[] = [
  { eventType: "dispute_reminder_3d", daysLeft: 3, fromHours: 72, toHours: 96 },
  { eventType: "dispute_reminder_1d", daysLeft: 1, fromHours: 24, toHours: 48 },
];

/** Which reminder a dispute is due, from the hours left before its deadline:
 *  at least `fromHours` and under `toHours`, else none. */
export function resolveReminderBucket(hoursLeft: number): ReminderBucket | null {
  for (const band of REMINDER_BANDS) {
    if (hoursLeft >= band.fromHours && hoursLeft < band.toHours) {
      return { eventType: band.eventType, daysLeft: band.daysLeft };
    }
  }
  return null;
}

/** The monthly billing run's day and hour, read from its cron expression
 *  ("0 4 1 * *") so the date in the won notice cannot drift from the run. */
function monthlyRunAt(): { day: number; hour: number; minute: number } {
  const [minute, hour, day] = CRON_SCHEDULE_MONTHLY.split(" ").map((p) => Number(p));
  return { minute, hour, day };
}

/**
 * When a dispute fee is invoiced: the first monthly billing run at or after the
 * resolution. PRICING.md: "Billed at the next monthly run after resolution", and
 * the billable predicate takes every win resolved before the run
 * (billableDisputeRowConditions, resolved_at <= asOf). Recova printed the first
 * of next month; this agrees with it except for a win resolved on the 1st before
 * the run, which that same run bills.
 */
export function nextDisputeBillingRun(resolvedAt: Date): Date {
  const { day, hour, minute } = monthlyRunAt();
  const y = resolvedAt.getUTCFullYear();
  const m = resolvedAt.getUTCMonth();
  const thisMonth = new Date(Date.UTC(y, m, day, hour, minute));
  if (resolvedAt.getTime() <= thisMonth.getTime()) return thisMonth;
  return new Date(Date.UTC(y, m + 1, day, hour, minute));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface RenderedNotice {
  subject: string;
  bodyHtml: string;
}

export interface CreatedNoticeInput {
  amountCents: number;
  currency: string;
  customerLabel: string;
  reason: string;
  evidenceDeadline: Date | null;
  disputeUrl: string;
}

/** Recova's sendDisputeCreatedEmail, without the triage line. */
export function createdNotice(input: CreatedNoticeInput): RenderedNotice {
  const amount = formatMoney(input.amountCents, input.currency);
  const who = escapeNoticeHtml(input.customerLabel);
  const deadlineLine = input.evidenceDeadline
    ? `Evidence deadline: <strong>${isoDay(input.evidenceDeadline)}</strong>.`
    : "No evidence deadline set by Stripe.";
  return {
    subject: `New dispute: ${amount} from ${input.customerLabel}`,
    bodyHtml:
      `<h1>New dispute.</h1>` +
      `<p>${who} disputed ${amount} for reason: <strong>${escapeNoticeHtml(titleCaseReason(input.reason))}</strong>.</p>` +
      `<p>${deadlineLine}</p>` +
      `<p>Auto-submit is off. We will remind you 3 days before the deadline.</p>` +
      `<p><a href="${input.disputeUrl}">Review dispute</a></p>`,
  };
}

export interface ReminderNoticeInput {
  amountCents: number;
  currency: string;
  customerLabel: string;
  reason: string;
  daysLeft: number;
  disputeUrl: string;
}

/** Recova's sendDisputeDeadlineReminderEmail, auto-submit off. */
export function reminderNotice(input: ReminderNoticeInput): RenderedNotice {
  const amount = formatMoney(input.amountCents, input.currency);
  const plural = input.daysLeft === 1 ? "day" : "days";
  return {
    subject: `URGENT: Dispute response due in ${input.daysLeft} ${plural}`,
    bodyHtml:
      `<h1>Dispute response due in ${input.daysLeft} ${plural}.</h1>` +
      `<p>${escapeNoticeHtml(input.customerLabel)} disputed ${amount} for reason: <strong>${escapeNoticeHtml(titleCaseReason(input.reason))}</strong>.</p>` +
      `<p>Current status: <strong>needs response</strong>.</p>` +
      `<p>Auto-submit is off. You need to review and submit, or choose to accept.</p>` +
      `<p><a href="${input.disputeUrl}">Review dispute</a></p>`,
  };
}

export interface OutcomeNoticeInput {
  won: boolean;
  amountCents: number;
  currency: string;
  reason: string;
  /** Foxhound submitted the evidence (disputes.submitted_at set). */
  foxhoundSubmitted: boolean;
  /** The fee the resolution writer snapshotted, or null when none is owed
   *  (billing-exempt, or the cap could not be priced yet). */
  feeCents: number | null;
  feeCurrency: string;
  /** When the fee is invoiced (nextDisputeBillingRun of the resolution). */
  invoiceDate: Date;
  listUrl: string;
}

/** Recova's sendDisputeOutcomeEmail: two won variants and the lost one. */
export function outcomeNotice(input: OutcomeNoticeInput): RenderedNotice {
  const amount = formatMoney(input.amountCents, input.currency);
  const reason = escapeNoticeHtml(titleCaseReason(input.reason));
  const link = `<p><a href="${input.listUrl}">View dispute</a></p>`;

  if (!input.won) {
    return {
      subject: `Dispute lost: ${amount}`,
      bodyHtml:
        `<h1>Dispute closed as lost.</h1>` +
        `<p>${amount} was deducted from your account by the cardholder bank. Reason: ${reason}.</p>` +
        `<p>No Foxhound fee. We only charge when we win.</p>` +
        link,
    };
  }

  if (!input.foxhoundSubmitted) {
    return {
      subject: `Dispute won: ${amount} (no Foxhound fee)`,
      bodyHtml:
        `<h1>You won the dispute.</h1>` +
        `<p>${amount} stays in your account.</p>` +
        `<p>Stripe Smart Disputes or your team submitted this response, not Foxhound. No Foxhound fee applies.</p>` +
        link,
    };
  }

  // A fee nobody will invoice is never announced: an exempt account, or a win
  // whose cap could not be priced yet (resolved_fee_error), gets the win
  // without a fee sentence rather than a number that is not owed.
  const feeLine =
    input.feeCents != null
      ? `<p>Foxhound fee: <strong>${formatMoney(input.feeCents, input.feeCurrency)}</strong> (${disputeFeeTerms()}). ` +
        `This will be invoiced on <strong>${isoDay(input.invoiceDate)}</strong>.</p>`
      : "";
  return {
    subject: `Dispute won: ${amount} recovered`,
    bodyHtml:
      `<h1>You won the dispute.</h1>` +
      `<p>${amount} stays in your account. Reason: ${reason}.</p>` +
      feeLine +
      link,
  };
}
