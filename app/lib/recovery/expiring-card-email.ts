import type { Block } from "capsomer/email";

import type { ExpiringCardAlertReason } from "~/db/schema";

// Pure: no env, no database, no clock. That is the opposite of the two merchant notices (sessions
// 47 and 48), which carry none of them.

export const EXPIRING_CARD_TEMPLATE = "expiring_card_alert";

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
  /** The card-update link. */
  updateUrl: string;
}

export function expiringCardSubject(input: {
  cardBrand: string | null;
  cardLast4: string | null;
}): string {
  const brand = input.cardBrand || EXPIRING_CARD_FALLBACKS.cardBrand;
  const last4 = input.cardLast4 || EXPIRING_CARD_FALLBACKS.cardLast4;
  return `Action required: Your ${brand} card ending in ${last4} is expiring`;
}

/**
 * The send seam renders them on Capsomer's email component, which writes the HTML part and the
 * plain-text part from the same blocks and escapes every value, so a customer name from Stripe is
 * shown exactly as written and never read as markup.
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
    {
      type: "paragraph",
      text: "If you've already updated your card, you can ignore this message.",
    },
    { type: "paragraph", text: "Thanks," },
    { type: "paragraph", text: senderName },
  ];
}

// THE NO-PAYMENT-METHOD VARIANT, for a 'no_payment_method' row: a trialing customer with nothing
// set up to pay when the trial converts. The card copy above would be untrue for it (there is no
// card, and nothing is expiring), so this is the same letter with only the facts changed. "Set up
// to pay for your subscription", not "on file": the check reads the defaults Stripe charges, so a
// customer may have a saved card that is simply not the default, and the copy says only what was
// checked.

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
    {
      type: "paragraph",
      text: "If you've already added a payment method, you can ignore this message.",
    },
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
