// Expiring-card pre-dunning (PRICING.md differentiator): alert a customer BEFORE
// their card expires, so the payment never fails in the first place. Pure
// date logic; the cron that queries Stripe cards and sends the alert is Phase 4c
// (send) / 4e (cron). A card is "expiring soon" if its last valid month is
// within `withinMonths` months of now (inclusive of the current month).

const MONTHS_LOOKAHEAD_DEFAULT = 1;

/**
 * True when a card with expiry (expiresYear, expiresMonth, 1-based) is at or past
 * its final usable month within `withinMonths` of `now`. A card is valid through
 * the END of its expiry month, so we compare year*12+month indices.
 */
export function isCardExpiringSoon(
  expiresYear: number,
  expiresMonth: number,
  now: Date,
  withinMonths: number = MONTHS_LOOKAHEAD_DEFAULT,
): boolean {
  const cardIndex = expiresYear * 12 + (expiresMonth - 1);
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  // Already expired (before this month) OR expiring within the lookahead window.
  return cardIndex <= nowIndex + withinMonths;
}

/** True when the card's expiry month is strictly before the current month. */
export function isCardExpired(
  expiresYear: number,
  expiresMonth: number,
  now: Date,
): boolean {
  const cardIndex = expiresYear * 12 + (expiresMonth - 1);
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return cardIndex < nowIndex;
}
