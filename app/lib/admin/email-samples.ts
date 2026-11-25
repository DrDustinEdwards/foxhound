import type { AuditResult } from "~/lib/audit/types";

// Sample data, the same sample the merchant's Send test email uses where it has
// one.
export const SAMPLE_AMOUNT_CENTS = 9900;
export const SAMPLE_AMOUNT = "$99.00";
export const SAMPLE_CURRENCY = "usd";
export const SAMPLE_CUSTOMER_LABEL = "Sample Customer";

/** A sample audit for the monthly report: every scope read, in US dollars. */
export function sampleAuditResult(now: Date): AuditResult {
  const usd = (cents: number) => [{ currency: SAMPLE_CURRENCY, cents }];
  const counted = (count: number, cents: number) => ({
    count,
    totalCents: cents,
    totals: usd(cents),
  });
  return {
    failedInvoices: {
      ok: true,
      data: {
        ...counted(12, 118800),
        byCategory: { soft: 7, network: 1, expired: 3, fraud: 0, revoked: 0, unknown: 1 },
        byCategoryTotals: {
          soft: usd(69300),
          network: usd(9900),
          expired: usd(29700),
          fraud: [],
          revoked: [],
          unknown: usd(9900),
        },
      },
    },
    expiringCards: {
      ok: true,
      data: { count: 3, mrrAtRiskCents: 29700, mrrAtRiskTotals: usd(29700), expiresByMonth: {} },
    },
    pastDueSubscriptions: { ok: true, data: counted(2, 19800) },
    cardUpdater: {
      ok: true,
      data: { eventsInWindow: 4, expiredCardDeclinesInWindow: 1, advisory: null, windowDays: 30 },
    },
    disputes: {
      ok: true,
      data: {
        open: counted(1, 4900),
        acceptedWithoutFighting: counted(0, 0),
        historical: { won: 3, lost: 1 },
      },
    },
    health: {
      ok: true,
      data: {
        mrrCents: 1250000,
        arrCents: 15000000,
        mrrTotals: usd(1250000),
        arrTotals: usd(15000000),
        activeSubscriptionsCount: 126,
        voluntaryChurnRateBps: 210,
        involuntaryChurnRateBps: 90,
      },
    },
    meta: {
      stripeAccountId: "acct_sample",
      lookbackDays: 30,
      currency: SAMPLE_CURRENCY,
      ranAt: now,
    },
  };
}
