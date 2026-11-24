// Third-party statistics, with their sources and the day they were read. Every statistic on a marketing surface carries an exact
// URL (a page, not a bare domain like "stripe.com/blog") and an as-of date, or it comes out. The date matters most because these
// numbers move under the citation without any edit here: the page said 56% citing stripe.com/billing, which had come to read
// 55%. A dated reading turns "this is true" into "this was true on a day you can check". Re-read from the live sources:
// stripe.com/billing "recover 55% of failed payments on average"; the Smart Retries post "Twenty-five percent of lapsed
// subscriptions are purely due to payment failures" (1 in 4) and "recovered by Stripe tools, continue on average for seven more" months.

/** The day the cited pages were last read, shown beside every statistic. One constant for all of them: they were read in one
 *  pass, and a per-statistic date would let one number update while others claim a freshness nobody checked. */
export const STAT_AS_OF = "2026-11-23";

/** The exact pages behind the marketing statistics: a reader must be able to land on the sentence being quoted. */
export const STAT_SOURCES = {
  stripeBilling: "https://stripe.com/billing",
  stripeSmartRetries: "https://stripe.com/blog/how-we-built-it-smart-retries",
} as const;

/** Stripe's own recovery rate, the number the "and the rest" argument hangs on (55 as of the date above; unchanged from the 2026-08-26 reading). */
export const STRIPE_RECOVERY_RATE_PERCENT = 55;

/** The share Stripe's own tools do NOT recover, derived so the two can never be edited apart. */
export const STRIPE_UNRECOVERED_RATE_PERCENT = 100 - STRIPE_RECOVERY_RATE_PERCENT;

/** Stripe's "Twenty-five percent of lapsed subscriptions are purely due to payment failures" (1 in 4; post dated 2024-01-23). */
export const STRIPE_LAPSED_PAYMENT_FAILURE_PERCENT = 25;

/** Stripe's "continue on average for seven more months" for subscriptions recovered by its tools. */
export const STRIPE_RECOVERED_MONTHS = 7;
