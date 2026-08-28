// THIRD-PARTY STATISTICS, WITH THEIR SOURCES AND THE DAY THEY WERE READ
// (377(9)).
//
// THE RULE THIS ENCODES: every statistic on a marketing surface carries an exact
// URL and an as-of date, or it comes out. Not a bare domain. 376 item 22 found
// the hero statistics cited to "stripe.com/blog", which is a publication rather
// than a page and cannot be checked by a reader or by a future session.
//
// AND THE DATE IS THE HALF THAT MATTERS MOST, because these numbers move
// underneath the citation without any edit here. 377(9) is the proof: the page
// said 56% citing stripe.com/billing, and stripe.com/billing had come to read
// 55%. The claim was once true, the citation was still pointing at the right
// place, and nothing in the repo could tell that the number had drifted. A dated
// reading turns "this is true" into "this was true on a day you can check".
//
// EVERY NUMBER BELOW WAS RE-READ FROM THE LIVE SOURCE IN THIS SESSION, not
// carried over from the ruling that named it:
//   - stripe.com/billing renders "recover 55% of failed payments on average".
//   - The Smart Retries post renders "Twenty-five percent of lapsed
//     subscriptions are purely due to payment failures", which is the 1 in 4,
//     and "recovered by Stripe tools, continue on average for seven more"
//     months, which is the 7 months.

/**
 * The day the cited pages were last read, as it appears beside every statistic.
 *
 * ONE CONSTANT FOR ALL OF THEM, deliberately: they were read in one pass, and a
 * per-statistic date would invite a session to update one number and leave the
 * others claiming a freshness nobody checked. When any of these is re-read, they
 * are all re-read and this moves once.
 */
export const STAT_AS_OF = "2026-08-26";

/** The exact pages behind the marketing statistics. Exact URLs, never a bare
 *  domain: a reader must be able to land on the sentence being quoted. */
export const STAT_SOURCES = {
  stripeBilling: "https://stripe.com/billing",
  stripeSmartRetries: "https://stripe.com/blog/how-we-built-it-smart-retries",
} as const;

/**
 * Stripe's own recovery rate, the number the whole "and the rest" argument
 * hangs on. 55 as of the date above; it was 56 when the copy was written.
 */
export const STRIPE_RECOVERY_RATE_PERCENT = 55;

/** The share Stripe's own tools do NOT recover, derived so the two can never be
 *  edited apart. The page used to say 56 and 44, which summed correctly and was
 *  wrong in both halves. */
export const STRIPE_UNRECOVERED_RATE_PERCENT = 100 - STRIPE_RECOVERY_RATE_PERCENT;
