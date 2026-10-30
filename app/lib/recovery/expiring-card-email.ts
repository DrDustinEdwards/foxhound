import type { Block } from "capsomer/email";

import type { ExpiringCardAlertReason } from "~/db/schema";

// The expiring-card alert's customer-facing copy, ported from legacy's
// `buildExpiringCardEmail` in app/api/cron/expiring-cards/route.ts (blob
// `717f6bbe`). Pure: no env, no database, no clock.
//
// THIS IS CUSTOMER-FACING MAIL SENT ON THE MERCHANT'S BEHALF, so it goes out on
// the CUSTOMER audience and carries the CAN-SPAM footer, the unsubscribe headers
// and the suppression gate. That is the opposite of the two merchant notices
// (sessions 47 and 48), which carry none of them.

export const EXPIRING_CARD_TEMPLATE = "expiring_card_alert";

/** Legacy's fallbacks, verbatim: `customer_name || 'there'`,
 *  `card_brand || 'Card'`, `card_last4 || '****'`, `sender_name || 'Support'`. */
const EXPIRING_CARD_FALLBACKS = {
  customerName: "there",
  cardBrand: "Card",
  cardLast4: "****",
  senderName: "Support",
} as const;

export interface ExpiringCardCopyInput {
  customerName: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  expiresMonth: number;
  expiresYear: number;
  senderName: string | null;
  /** The card-update link. Legacy's is a Stripe billing portal session; this is
   *  Foxhound's own /p/:token page in alert mode. */
  updateUrl: string;
}

/** Legacy's subject, verbatim. */
export function expiringCardSubject(input: {
  cardBrand: string | null;
  cardLast4: string | null;
}): string {
  const brand = input.cardBrand || EXPIRING_CARD_FALLBACKS.cardBrand;
  const last4 = input.cardLast4 || EXPIRING_CARD_FALLBACKS.cardLast4;
  return `Action required: Your ${brand} card ending in ${last4} is expiring`;
}

/**
 * Recova's body, verbatim in wording and order, as Capsomer's email blocks.
 * The send seam renders them on Capsomer's email component,
 * which writes the HTML part and the plain-text part from the same blocks and
 * escapes every value, so a customer name from Stripe is shown exactly as
 * written and never read as markup.
 *
 * WHAT CAPSOMER'S BLOCKS CANNOT YET CARRY, each kept as words:
 *
 * 1. Recova's <strong> around the card and the date. A paragraph is one plain
 *    string until capsomer job_2adddfaab5dc adds a bold run.
 * 2. Recova's "Thanks,<br>{senderName}" line break. A paragraph has no line
 *    break, so the sign-off is two paragraphs, same words.
 *
 * TWO DIFFERENCES FROM RECOVA'S MARKUP, both recorded:
 *
 * - THE BUTTON is Capsomer's, in Foxhound's amber, not Recova's own
 *   inline style. The label "Update Payment Method" is Recova's.
 * - THE LINK TARGET is Foxhound's own /p/:token card-update page rather than a
 *   Stripe billing portal session (APPROVED-DIFFERENCES, "yes", 2026-09-19).
 *   Recova's dashboard fallback is deliberately NOT ported: a link that does
 *   not update a card is worse than no link.
 *
 * The month is zero-padded to two digits, as Recova pads it. Pure.
 */
export function buildExpiringCardEmail(input: ExpiringCardCopyInput): Block[] {
  const customerName = input.customerName || EXPIRING_CARD_FALLBACKS.customerName;
  const brand = input.cardBrand || EXPIRING_CARD_FALLBACKS.cardBrand;
  const last4 = input.cardLast4 || EXPIRING_CARD_FALLBACKS.cardLast4;
  const senderName = input.senderName || EXPIRING_CARD_FALLBACKS.senderName;
  const month = String(input.expiresMonth).padStart(2, "0");
  const year = String(input.expiresYear);

  return [
    { type: "paragraph", text: `Hi ${customerName},` },
    {
      type: "paragraph",
      text: `We wanted to give you a heads up that your ${brand} card ending in ${last4} is expiring on ${month}/${year}.`,
    },
    {
      type: "paragraph",
      text: "To avoid any interruption to your service, please update your payment method before it expires.",
    },
    { type: "button", label: "Update Payment Method", url: input.updateUrl },
    { type: "paragraph", text: "If you've already updated your card, you can ignore this message." },
    { type: "paragraph", text: "Thanks," },
    { type: "paragraph", text: senderName },
  ];
}

// THE NO-PAYMENT-METHOD VARIANT, for a 'no_payment_method' row: a trialing
// customer with nothing set up to pay when the trial converts. The card copy
// above would be untrue for it (there is no card, and nothing is expiring), so
// this is the same letter with only the facts changed. The row's month and
// year are the trial end, which is all the copy says about the date.
//
// "Set up to pay for your subscription", not "on file": the check reads the
// defaults Stripe charges, so a customer may have a saved card that is simply
// not the default, and the copy says only what was checked.

export interface NoPaymentMethodCopyInput {
  customerName: string | null;
  trialEndsMonth: number;
  trialEndsYear: number;
  senderName: string | null;
  updateUrl: string;
}

export function noPaymentMethodSubject(): string {
  return "Action required: Add a payment method before your trial ends";
}

export function buildNoPaymentMethodEmail(input: NoPaymentMethodCopyInput): Block[] {
  const customerName = input.customerName || EXPIRING_CARD_FALLBACKS.customerName;
  const senderName = input.senderName || EXPIRING_CARD_FALLBACKS.senderName;
  const month = String(input.trialEndsMonth).padStart(2, "0");
  const year = String(input.trialEndsYear);

  return [
    { type: "paragraph", text: `Hi ${customerName},` },
    {
      type: "paragraph",
      text: `We wanted to give you a heads up that there is no payment method set up to pay for your subscription, and your trial ends on ${month}/${year}.`,
    },
    {
      type: "paragraph",
      text: "To avoid any interruption to your service, please add a payment method before your trial ends.",
    },
    { type: "button", label: "Add Payment Method", url: input.updateUrl },
    { type: "paragraph", text: "If you've already added a payment method, you can ignore this message." },
    { type: "paragraph", text: "Thanks," },
    { type: "paragraph", text: senderName },
  ];
}

/** The subject and blocks for one alert row, by its reason. */
export function expiringCardAlertContent(
  input: ExpiringCardCopyInput & { reason: ExpiringCardAlertReason },
): { subject: string; blocks: Block[] } {
  if (input.reason === "no_payment_method") {
    return {
      subject: noPaymentMethodSubject(),
      blocks: buildNoPaymentMethodEmail({
        customerName: input.customerName,
        trialEndsMonth: input.expiresMonth,
        trialEndsYear: input.expiresYear,
        senderName: input.senderName,
        updateUrl: input.updateUrl,
      }),
    };
  }
  return { subject: expiringCardSubject(input), blocks: buildExpiringCardEmail(input) };
}
