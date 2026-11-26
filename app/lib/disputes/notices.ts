import { plural, titleCase } from "@drdustinedwards/site-helpers/text";
import { isoDay } from "@drdustinedwards/site-helpers/xml";

import { DISPUTE_AUTO_SUBMIT_HOURS } from "~/lib/disputes/approval";
import { disputeFeeCents } from "~/lib/billing/fees";
import { CRON_SCHEDULE_MONTHLY, DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { recoveryFooterNote, type EmailNotice } from "~/lib/email/templates";
import { formatMoney, formatMoneyShort } from "@dustinedwards/site-runtime/money";

export const DISPUTE_CREATED_TEMPLATE = "merchant_dispute_created";
export const DISPUTE_REMINDER_TEMPLATE = "merchant_dispute_reminder";
export const DISPUTE_OUTCOME_TEMPLATE = "merchant_dispute_outcome";
export const DISPUTE_AUTO_SUBMITTED_TEMPLATE = "merchant_dispute_auto_submitted";

export const DISPUTE_NOTICE_FROM_NAME = "Foxhound";

export function noticeCustomerLabel(name: string | null, email: string | null): string {
  return name || email || "Unknown customer";
}

export interface ReminderBucket {
  eventType: "dispute_reminder_3d" | "dispute_reminder_1d";
  daysLeft: 3 | 1;
}

export const REMINDER_BANDS: readonly (ReminderBucket & { fromHours: number; toHours: number })[] =
  [
    { eventType: "dispute_reminder_3d", daysLeft: 3, fromHours: 72, toHours: 96 },
    { eventType: "dispute_reminder_1d", daysLeft: 1, fromHours: 24, toHours: 48 },
  ];

/**
 * A reminder's idempotency key, `<band>:<dispute id>`: the send claim's key,
 * the outcome's key, and what the reminder cron's selection excludes on.
 */
export function reminderKey(eventType: ReminderBucket["eventType"], disputeId: string): string {
  return `${eventType}:${disputeId}`;
}

/**
 * The monthly billing run's day and hour, read from its cron expression ("0 4 1
 * * *") so the date in the won notice cannot drift from the run.
 */
function monthlyRunAt(): { day: number; hour: number; minute: number } {
  const [minute, hour, day] = CRON_SCHEDULE_MONTHLY.split(" ").map((p) => Number(p));
  return { minute, hour, day };
}

/**
 * When a dispute fee is invoiced: the first monthly billing run at or after the
 * resolution. PRICING.md: "Billed at the next monthly run after resolution",
 * and the billable predicate takes every win resolved before the run
 * (billableDisputeRowConditions, resolved_at <= asOf).
 */
export function nextDisputeBillingRun(resolvedAt: Date): Date {
  const { day, hour, minute } = monthlyRunAt();
  const y = resolvedAt.getUTCFullYear();
  const m = resolvedAt.getUTCMonth();
  const thisMonth = new Date(Date.UTC(y, m, day, hour, minute));
  if (resolvedAt.getTime() <= thisMonth.getTime()) return thisMonth;
  return new Date(Date.UTC(y, m + 1, day, hour, minute));
}

export interface NoticeMail {
  subject: string;
  notice: EmailNotice;
}

const DISPUTE_FOOTER_FALLBACK_SENDER = "Foxhound";

export function disputeNoticeFooterNote(
  senderName: string | null | undefined,
  year: number,
): string {
  return recoveryFooterNote(
    senderName?.trim() ? senderName.trim() : DISPUTE_FOOTER_FALLBACK_SENDER,
    year,
  );
}

export interface CreatedNoticeInput {
  amountCents: number;
  currency: string;
  customerLabel: string;
  reason: string;
  evidenceDeadline: Date | null;
  disputeUrl: string;
  triage?: { recommendation: string; confidence: number | null; reasoning: string | null } | null;
  autoSubmit: boolean;
}

function triageLine(triage: CreatedNoticeInput["triage"]): string | null {
  if (!triage) return null;
  const score = triage.confidence === null ? "" : ` (${triage.confidence}/100)`;
  return `Recommendation: ${triage.recommendation.toUpperCase()}${score}. ${triage.reasoning ?? ""}`.trim();
}

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
        `${input.customerLabel} disputed ${amount} for reason: ${titleCase(input.reason)}.`,
        deadlineLine,
        ...(triageLine(input.triage) ? [triageLine(input.triage) as string] : []),
        input.autoSubmit
          ? `Auto-submit is on. We will submit the response ${DISPUTE_AUTO_SUBMIT_HOURS} hours before the deadline unless you change it.`
          : `Auto-submit is off. We will remind you ${REMINDER_BANDS[0].daysLeft} days before the deadline.`,
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
  /**
   * A dispute_approvals row stands while the dispute is still unsubmitted: the
   * submission was refused, is in flight, or was never confirmed.
   */
  approved: boolean;
  autoSubmit: boolean;
}

const REMINDER_ACTION_LINE =
  "Auto-submit is off. You need to review and submit, or choose to accept.";
const REMINDER_AUTO_LINE =
  "Auto-submit is on. We will submit at the 24-hour mark using the staged evidence unless you cancel or override it.";

const REMINDER_APPROVED_LINE =
  "Your evidence is approved, but Stripe has not confirmed the submission. Check this dispute in Stripe, or open it in Foxhound to submit it again.";

export function reminderNotice(input: ReminderNoticeInput): NoticeMail {
  const amount = formatMoney(input.amountCents, input.currency);
  const due = plural(input.daysLeft, "day");
  return {
    subject: `URGENT: Dispute response due in ${due}`,
    notice: {
      title: `Dispute response due in ${due}.`,
      body: [
        `${input.customerLabel} disputed ${amount} for reason: ${titleCase(input.reason)}.`,
        "Current status: needs response.",
        input.approved
          ? REMINDER_APPROVED_LINE
          : input.autoSubmit
            ? REMINDER_AUTO_LINE
            : REMINDER_ACTION_LINE,
      ],
      action: { label: "Review dispute", url: input.disputeUrl },
    },
  };
}

export interface AutoSubmittedNoticeInput {
  amountCents: number;
  currency: string;
  customerLabel: string;
  reason: string;
  disputeUrl: string;
}

export function autoSubmittedNotice(input: AutoSubmittedNoticeInput): NoticeMail {
  const amount = formatMoney(input.amountCents, input.currency);
  return {
    subject: `Dispute response submitted: ${amount}`,
    notice: {
      title: "Dispute response submitted.",
      body: [
        `We submitted evidence to Stripe for the ${amount} dispute from ${input.customerLabel} (reason: ${titleCase(input.reason)}).`,
        "What we included: transaction context, card verification (AVS, CVV, 3DS, Radar), prior charge history, subscription tenure where applicable, and recovery email engagement.",
        "The cardholder bank now has 60 to 75 days to decide. No action needed from you.",
      ],
      action: { label: "View submission", url: input.disputeUrl },
    },
  };
}

export interface OutcomeNoticeInput {
  won: boolean;
  amountCents: number;
  currency: string;
  reason: string;
  foxhoundSubmitted: boolean;
  /**
   * The fee the resolution writer snapshotted, or null when none is owed
   * (billing-exempt, or the cap could not be priced yet).
   */
  feeCents: number | null;
  feeCurrency: string;
  /**
   * When the fee is invoiced (nextDisputeBillingRun of the resolution), or null
   * while the account is paused: the billing run skips a paused account
   * (accountBillingEligibleCondition) and bills the fee at the first run after
   * processing resumes, so no date is promised.
   */
  invoiceDate: Date | null;
  listUrl: string;
}

function wonFeeTerms(amountCents: number, feeCents: number): string {
  const pct = DISPUTE_FEE_BPS / 100;
  const terms = `${Number.isInteger(pct) ? pct : pct.toFixed(1)}% of the saved amount`;
  const uncapped = disputeFeeCents(amountCents, Number.POSITIVE_INFINITY);
  return feeCents < uncapped
    ? `${terms}, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")}`
    : terms;
}

export function outcomeNotice(input: OutcomeNoticeInput): NoticeMail {
  const amount = formatMoney(input.amountCents, input.currency);
  const reason = titleCase(input.reason);
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
