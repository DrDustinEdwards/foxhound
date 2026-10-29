import { formatMoney } from "~/lib/money-format";

import type { NoticeMail } from "./notices";

// EARLY FRAUD WARNINGS: the words and the pure rules, no database and no send.
// A card network sends Stripe an early fraud warning (radar.early_fraud_warning)
// days or weeks before a fraud chargeback. Refunding the charge first avoids the
// dispute fee and keeps the dispute off the merchant's ratio. Recova had no such
// surface; Dustin approved building it on 2026-10-29.
//
// Foxhound never refunds on its own. The merchant chooses Refund or Dismiss on
// the disputes dashboard, and a refund earns Foxhound nothing: it is not a won
// dispute, so no fee line, outcome or billable row is written for it.

export const EARLY_FRAUD_WARNING_TEMPLATE = "merchant_early_fraud_warning";

/** Where the notice links and the page's section anchor. */
export const EARLY_FRAUD_WARNINGS_ANCHOR = "early-fraud-warnings";
export const EARLY_FRAUD_WARNINGS_PATH = `/disputes/dashboard#${EARLY_FRAUD_WARNINGS_ANCHOR}`;

/** Stripe's documented fraud_type values, in words. Anything else is shown
 *  as Stripe sent it, underscores turned to spaces. */
const FRAUD_TYPE_WORDS: Record<string, string> = {
  card_never_received: "Card never received",
  fraudulent_card_application: "Fraudulent card application",
  made_with_counterfeit_card: "Counterfeit card",
  made_with_lost_card: "Lost card",
  made_with_stolen_card: "Stolen card",
  misc: "Other",
  unauthorized_use_of_card: "Unauthorized use of card",
};

export function fraudTypeWords(fraudType: string): string {
  const known = FRAUD_TYPE_WORDS[fraudType];
  if (known) return known;
  const spaced = fraudType.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Unknown";
}

/** A warning the merchant can still act on: Stripe still calls it actionable
 *  (the charge is neither fully refunded nor disputed), and nobody has refunded
 *  or dismissed it in Foxhound. */
export function isOpenWarning(row: { actionable: boolean; refundedAt: Date | null; dismissedAt: Date | null }): boolean {
  return row.actionable && row.refundedAt === null && row.dismissedAt === null;
}

/** The customer as the page and the notice name them. */
export function warningCustomerLabel(row: {
  customerName: string | null;
  customerEmail: string | null;
  stripeCustomerId: string | null;
}): string {
  return row.customerName || row.customerEmail || row.stripeCustomerId || "Unknown customer";
}

export interface WarningNoticeInput {
  amountCents: number;
  currency: string;
  customerLabel: string;
  fraudType: string;
  chargeId: string;
  pageUrl: string;
}

/** The merchant's notice for a new actionable warning, on Capsomer's notice
 *  template like the dispute notices. */
export function earlyFraudWarningNotice(input: WarningNoticeInput): NoticeMail {
  const amount = formatMoney(input.amountCents, input.currency);
  return {
    subject: `Early fraud warning: ${amount} from ${input.customerLabel}`,
    notice: {
      title: "Early fraud warning.",
      body: [
        `The card issuer reported the ${amount} charge from ${input.customerLabel} as possible fraud (${fraudTypeWords(input.fraudType)}). Charge: ${input.chargeId}.`,
        "A warning like this often comes before a fraud dispute. Refunding the charge before a dispute is filed avoids the dispute fee and keeps the dispute off your dispute rate.",
        "Foxhound does not refund anything on its own. Open the warning to refund the charge or dismiss it.",
      ],
      action: { label: "Review warning", url: input.pageUrl },
    },
  };
}

/** What the page says when a refund is refused or its result is unknown. */
export const REFUND_MESSAGES = {
  not_found: "That warning was not found.",
  already_refunded: "This charge was already refunded through Foxhound.",
  dismissed: "This warning was dismissed.",
  not_actionable: "Stripe no longer marks this warning as actionable: the charge was refunded or disputed.",
  stripe_refunded: "This charge is already fully refunded in Stripe, so there is nothing to refund. Dismiss the warning to clear it.",
  stripe_disputed: "This charge is already disputed, so it cannot be refunded here. Respond to the dispute instead.",
  no_connection: "No connected Stripe account for this warning.",
  stripe_refused: "Stripe did not refund the charge.",
  unknown:
    "Something went wrong while refunding. Stripe may or may not have refunded this charge, so check it in Stripe before trying again.",
  not_recorded:
    "Stripe refunded the charge, but Foxhound could not record it yet. Check the charge in Stripe; this warning clears when Stripe reports the change.",
} as const;

export type RefundRefusal = keyof typeof REFUND_MESSAGES;
