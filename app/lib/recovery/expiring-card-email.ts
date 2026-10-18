import type { Block } from "capsomer/email";

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
export const EXPIRING_CARD_FALLBACKS = {
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
   *  Foxhound's own /p/:token page in alert mode (341 binding 2). */
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
 * Recova's body, verbatim in wording and order, as Capsomer's email blocks
 * (J90, row E12). The send seam renders them on Capsomer's email component,
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
 * - THE BUTTON is Capsomer's, in Foxhound's teal (Q3, Q11), not Recova's own
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
