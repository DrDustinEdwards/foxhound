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
 * Legacy's body, verbatim in wording and order.
 *
 * TWO DIFFERENCES, both forced and both recorded:
 *
 * 1. THE BUTTON IS A PLAIN ANCHOR. Legacy styles it from its EMAIL_COLORS
 *    module, which Foxhound does not have, and check-tokens fails the build on
 *    raw hex. The label "Update Payment Method" is legacy's.
 * 2. THE LINK TARGET is Foxhound's own /p/:token card-update page rather than a
 *    Stripe billing portal session (341 binding 2). Legacy's dashboard fallback
 *    is deliberately NOT ported: a link that does not update a card is worse
 *    than no link.
 *
 * The month is zero-padded to two digits, as legacy pads it.
 */
export function buildExpiringCardEmail(input: ExpiringCardCopyInput): string {
  const customerName = input.customerName || EXPIRING_CARD_FALLBACKS.customerName;
  const brand = input.cardBrand || EXPIRING_CARD_FALLBACKS.cardBrand;
  const last4 = input.cardLast4 || EXPIRING_CARD_FALLBACKS.cardLast4;
  const senderName = input.senderName || EXPIRING_CARD_FALLBACKS.senderName;
  const month = String(input.expiresMonth).padStart(2, "0");
  const year = String(input.expiresYear);

  return (
    `<p>Hi ${customerName},</p>` +
    `<p>We wanted to give you a heads up that your <strong>${brand} card ending in ${last4}</strong> ` +
    `is expiring on <strong>${month}/${year}</strong>.</p>` +
    `<p>To avoid any interruption to your service, please update your payment method before it expires.</p>` +
    `<p><a href="${input.updateUrl}">Update Payment Method</a></p>` +
    `<p>If you've already updated your card, you can ignore this message.</p>` +
    `<p>Thanks,<br>${senderName}</p>`
  );
}
