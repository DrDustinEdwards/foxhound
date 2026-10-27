import { isoDay } from "@drdustinedwards/site-helpers/xml";

import { disputeFeeCents } from "~/lib/billing/fees";
import { CRON_SCHEDULE_MONTHLY, DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { recoveryFooterNote, type EmailNotice } from "~/lib/email/templates";
import { formatMoney, formatMoneyShort } from "~/lib/money-format";

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
//   snapshotted (resolved_fee_cents, which carries the $500 cap) in Recova's
//   words, "(20% of the saved amount)", the percentage read from the constants.
//   Recova had no cap (its lib/dispute-fees.ts, blob 00b58c14), so where the cap
//   set the fee the sentence adds ", capped at $500", and only there: Recova's
//   words alone would be untrue above the cap (RULES.md 1.2, 2.1).
//
// ALL FOUR NOTICES (J92 rows E16 and E17, J93 rows E19 and E20) are Capsomer's
// `notice` template, as the recovery notification is (E10): Recova's bold first
// line is the title and the mail's one heading, its sentences are the
// paragraphs, and "Review dispute" is the button. Plain strings, never markup:
// Capsomer escapes each one, so a customer name from Stripe is shown exactly as
// written. Recova's bold runs (the reason, the deadline, the fee and its invoice
// date) are plain text here (capsomer job_2adddfaab5dc).
// The footer is Recova's wrapEmailHtml line with the connection's sender name
// (disputeNoticeFooterNote), and send.ts puts "Manage email settings" under it.

export const DISPUTE_CREATED_TEMPLATE = "merchant_dispute_created";
export const DISPUTE_REMINDER_TEMPLATE = "merchant_dispute_reminder";
export const DISPUTE_OUTCOME_TEMPLATE = "merchant_dispute_outcome";

/** The platform's From name, as on the recovery notification. Recova sent
 *  these from its own disputes address under the platform name. */
export const DISPUTE_NOTICE_FROM_NAME = "Foxhound";

/** Recova's titleCaseReason: "product_not_received" to "Product Not Received". */
function titleCaseReason(reason: string): string {
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

/** A reminder's idempotency key, `<band>:<dispute id>`: the send claim's key,
 *  the outcome's key, and what the reminder cron's selection excludes on. */
export function reminderKey(eventType: ReminderBucket["eventType"], disputeId: string): string {
  return `${eventType}:${disputeId}`;
}

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

/** A notice on Capsomer's `notice` template: the subject and the notice. */
export interface NoticeMail {
  subject: string;
  notice: EmailNotice;
}

/** The sender name Recova's dispute mail puts in its footer: the connection's
 *  `sender_name ?? 'Recova'`, with Foxhound's name. A blank name falls back as
 *  well, so the sentence never reads "from  about". */
const DISPUTE_FOOTER_FALLBACK_SENDER = "Foxhound";

/** Recova's footer sentence on these notices (lib/email.ts wrapEmailHtml with
 *  `params.senderName ?? 'Recova'`). Pure. */
export function disputeNoticeFooterNote(senderName: string | null | undefined, year: number): string {
  return recoveryFooterNote(senderName?.trim() ? senderName.trim() : DISPUTE_FOOTER_FALLBACK_SENDER, year);
}

export interface CreatedNoticeInput {
  amountCents: number;
  currency: string;
  customerLabel: string;
  reason: string;
  evidenceDeadline: Date | null;
  disputeUrl: string;
}

/** Recova's sendDisputeCreatedEmail, auto-submit off and without the triage
 *  line (see the header). */
export function createdNotice(input: CreatedNoticeInput): NoticeMail {
  const amount = formatMoney(input.amountCents, input.currency);
  const deadlineLine = input.evidenceDeadline
    ? `Evidence deadline: ${isoDay(input.evidenceDeadline)}.`
    : "No evidence deadline set by Stripe.";
  return {
    subject: `New dispute: ${amount} from ${input.customerLabel}`,
    notice: {
      title: "New dispute.",
      body: [
        `${input.customerLabel} disputed ${amount} for reason: ${titleCaseReason(input.reason)}.`,
        deadlineLine,
        "Auto-submit is off. We will remind you 3 days before the deadline.",
      ],
      action: { label: "Review dispute", url: input.disputeUrl },
    },
  };
}

export interface ReminderNoticeInput {
  amountCents: number;
  currency: string;
  customerLabel: string;
  reason: string;
  daysLeft: number;
  disputeUrl: string;
  /** A dispute_approvals row stands while the dispute is still unsubmitted:
   *  the submission was refused, is in flight, or was never confirmed. */
  approved: boolean;
}

/** Recova's line, for a dispute nobody has approved yet. */
const REMINDER_ACTION_LINE = "Auto-submit is off. You need to review and submit, or choose to accept.";

/** The line for an approved dispute Stripe has not confirmed as submitted
 *  (job_2663d92094ab). Accept is refused while an approval stands (PR 149
 *  review), so Recova's "or choose to accept" would offer what the page
 *  refuses; the page's Approve and submit resumes the standing approval, and
 *  Stripe is where the merchant can see whether the evidence arrived. Recova
 *  had no such state: its approval and submission were one step. */
const REMINDER_APPROVED_LINE =
  "Your evidence is approved, but Stripe has not confirmed the submission. Check this dispute in Stripe, or open it in Foxhound to submit it again.";

/** Recova's sendDisputeDeadlineReminderEmail, auto-submit off. */
export function reminderNotice(input: ReminderNoticeInput): NoticeMail {
  const amount = formatMoney(input.amountCents, input.currency);
  const plural = input.daysLeft === 1 ? "day" : "days";
  return {
    subject: `URGENT: Dispute response due in ${input.daysLeft} ${plural}`,
    notice: {
      title: `Dispute response due in ${input.daysLeft} ${plural}.`,
      body: [
        `${input.customerLabel} disputed ${amount} for reason: ${titleCaseReason(input.reason)}.`,
        "Current status: needs response.",
        input.approved ? REMINDER_APPROVED_LINE : REMINDER_ACTION_LINE,
      ],
      action: { label: "Review dispute", url: input.disputeUrl },
    },
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
  /** When the fee is invoiced (nextDisputeBillingRun of the resolution), or
   *  null while the account is paused: the billing run skips a paused account
   *  (accountBillingEligibleCondition) and bills the fee at the first run after
   *  processing resumes, so no date is promised (PR 149 review). */
  invoiceDate: Date | null;
  listUrl: string;
}

/** The fee's terms in the won notice: Recova's "20% of the saved amount", and
 *  the cap only when the cap is what set the fee. The percentage and the cap
 *  are the constants the fee writer uses (disputeFeeCents). Pure. */
function wonFeeTerms(amountCents: number, feeCents: number): string {
  const pct = DISPUTE_FEE_BPS / 100;
  const terms = `${Number.isInteger(pct) ? pct : pct.toFixed(1)}% of the saved amount`;
  const uncapped = disputeFeeCents(amountCents, Number.POSITIVE_INFINITY);
  return feeCents < uncapped ? `${terms}, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")}` : terms;
}

/** Recova's sendDisputeOutcomeEmail: two won variants and the lost one, each
 *  with "View dispute" to the disputes list (Recova's APP_URL/disputes). */
export function outcomeNotice(input: OutcomeNoticeInput): NoticeMail {
  const amount = formatMoney(input.amountCents, input.currency);
  const reason = titleCaseReason(input.reason);
  const action = { label: "View dispute", url: input.listUrl };

  if (!input.won) {
    return {
      subject: `Dispute lost: ${amount}`,
      notice: {
        title: "Dispute closed as lost.",
        body: [
          `${amount} was deducted from your account by the cardholder bank. Reason: ${reason}.`,
          "No Foxhound fee. We only charge when we win.",
        ],
        action,
      },
    };
  }

  if (!input.foxhoundSubmitted) {
    return {
      subject: `Dispute won: ${amount} (no Foxhound fee)`,
      notice: {
        title: "You won the dispute.",
        body: [
          `${amount} stays in your account.`,
          "Stripe Smart Disputes or your team submitted this response, not Foxhound. No Foxhound fee applies.",
        ],
        action,
      },
    };
  }

  // A fee nobody will invoice is never announced: an exempt account, or a win
  // whose cap could not be priced yet (resolved_fee_error), gets the win
  // without a fee sentence rather than a number that is not owed.
  const body = [`${amount} stays in your account. Reason: ${reason}.`];
  if (input.feeCents != null) {
    const fee = formatMoney(input.feeCents, input.feeCurrency);
    const when = input.invoiceDate
      ? `This will be invoiced on ${isoDay(input.invoiceDate)}.`
      : "It will be invoiced at the first monthly billing run after processing resumes.";
    body.push(`Foxhound fee: ${fee} (${wonFeeTerms(input.amountCents, input.feeCents)}). ${when}`);
  }
  return {
    subject: `Dispute won: ${amount} recovered`,
    notice: { title: "You won the dispute.", body, action },
  };
}
