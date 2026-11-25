import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY } from "~/lib/constants";
import {
  buildCardUpdaterAdvisory,
  extractDeclineCode,
  monthlyPlanCents,
  runAudit,
} from "~/lib/audit/engine";
import { type AuditInputs, type ScopeOutcome } from "~/lib/audit/types";
import { AUDIT_SUMMARY_FALLBACK, sanitizeSummary } from "~/lib/audit/summary";

// The pure audit engine: each scope has the case just inside and just outside its rule.

const RAN_AT = new Date("2026-08-24T12:00:00.000Z");
const DAY = 86_400_000;
const secondsAt = (msAgo: number) => Math.floor((RAN_AT.getTime() - msAgo) / 1000);

const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });
const failed = (reason: string): ScopeOutcome<never[]> => ({ ok: false, reason });

function reads(over: Partial<AuditInputs> = {}): AuditInputs {
  return {
    uncollectibleInvoices: ok<Stripe.Invoice>([]),
    openInvoices: ok<Stripe.Invoice>([]),
    subscriptions: ok<Stripe.Subscription>([]),
    disputes: ok<Stripe.Dispute>([]),
    cardUpdaterEvents: ok<Stripe.Event>([]),
    ...over,
  };
}

function audit(over: Partial<AuditInputs> = {}, lookbackDays = 90) {
  return runAudit({
    stripeAccountId: "acct_walked",
    lookbackDays,
    ranAt: RAN_AT,
    reads: reads(over),
  });
}

/** A loosely typed fixture invoice. */
const invoice = (o: Record<string, unknown>) =>
  ({ amount_due: 0, currency: "usd", ...o }) as unknown as Stripe.Invoice;

const subscription = (o: Record<string, unknown>) =>
  ({ status: "active", currency: "usd", ...o }) as unknown as Stripe.Subscription;

const price = (unitAmount: number, interval: string, intervalCount = 1) => ({
  items: {
    data: [
      {
        price: { unit_amount: unitAmount, recurring: { interval, interval_count: intervalCount } },
      },
    ],
  },
});

const card = (expMonth: number, expYear: number) => ({
  default_payment_method: { card: { exp_month: expMonth, exp_year: expYear } },
});

const dispute = (o: Record<string, unknown>) =>
  ({ amount: 0, currency: "usd", ...o }) as unknown as Stripe.Dispute;

/** Narrow a scope to its data, failing the test with the reason if it did not. */
function data<T>(scope: ScopeOutcome<T>): T {
  if (!scope.ok) throw new Error(`scope failed: ${scope.reason}`);
  return scope.data;
}

describe("failed invoices", () => {
  it("takes every uncollectible, and ONLY the open invoices whose due date has passed", () => {
    const result = audit({
      uncollectibleInvoices: ok<Stripe.Invoice>([invoice({ amount_due: 1_000 })]),
      openInvoices: ok<Stripe.Invoice>([
        invoice({ amount_due: 2_000, due_date: secondsAt(DAY) }),
        invoice({ amount_due: 4_000, due_date: secondsAt(-DAY) }),
      ]),
    });
    expect(data(result.failedInvoices).count).toBe(2);
    expect(data(result.failedInvoices).totalCents).toBe(3_000);
  });

  it("an open invoice with NO due date is not overdue, which a truthy check would get wrong", () => {
    const result = audit({
      openInvoices: ok<Stripe.Invoice>([invoice({ amount_due: 9_000, due_date: null })]),
    });
    expect(data(result.failedInvoices).count).toBe(0);
  });

  it("the decline-code fallback chain runs in order", () => {
    expect(
      extractDeclineCode(
        invoice({
          last_finalization_error: { decline_code: "a" },
          last_payment_error: { code: "b" },
        }),
      ),
    ).toBe("a");
    expect(
      extractDeclineCode(
        invoice({ last_payment_error: { code: "b" }, charge: { failure_code: "c" } }),
      ),
    ).toBe("b");
    expect(extractDeclineCode(invoice({ charge: { failure_code: "c" } }))).toBe("c");
    // A charge that is still an id string carries no failure code.
    expect(extractDeclineCode(invoice({ charge: "ch_1" }))).toBeNull();
  });
});

describe("expiring cards", () => {
  it("counts this month and next month, and NOT the month after", () => {
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ customer: "cus_a", ...card(8, 2026), ...price(1_000, "month") }),
        subscription({ customer: "cus_b", ...card(9, 2026), ...price(2_000, "month") }),
        subscription({ customer: "cus_c", ...card(10, 2026), ...price(4_000, "month") }),
      ]),
    });
    expect(data(result.expiringCards).count).toBe(2);
    expect(data(result.expiringCards).mrrAtRiskCents).toBe(3_000);
  });

  it("AN ALREADY-EXPIRED CARD COUNTS, which is the opposite of the expiring-card cron", () => {
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ customer: "cus_old", ...card(1, 2024), ...price(5_000, "month") }),
      ]),
    });
    expect(data(result.expiringCards).count).toBe(1);
  });

  it("dedupes by customer, so two subscriptions on one card count once", () => {
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ customer: "cus_a", ...card(8, 2026), ...price(1_000, "month") }),
        subscription({ customer: "cus_a", ...card(8, 2026), ...price(9_000, "month") }),
      ]),
    });
    expect(data(result.expiringCards).count).toBe(1);
    expect(data(result.expiringCards).mrrAtRiskCents).toBe(1_000);
  });

  it("normalizes every recurring interval to monthly cents", () => {
    expect(monthlyPlanCents(subscription(price(1_200_00, "year")) as Stripe.Subscription)).toBe(
      10_000,
    );
    expect(monthlyPlanCents(subscription(price(100, "day")) as Stripe.Subscription)).toBe(3_000);
    // A month holds 52/12 weeks, the conversion Intelligence uses too.
    expect(monthlyPlanCents(subscription(price(100, "week")) as Stripe.Subscription)).toBe(433);
    expect(monthlyPlanCents(subscription(price(500, "month", 2)) as Stripe.Subscription)).toBe(250);
  });
});

describe("seats and extra items", () => {
  const seats = (quantity: number) => ({
    items: {
      data: [
        {
          quantity,
          price: { unit_amount: 2_000, recurring: { interval: "month", interval_count: 1 } },
        },
        { price: { unit_amount: 500, recurring: { interval: "month", interval_count: 1 } } },
      ],
    },
  });

  it("sums every item times its quantity, in MRR and in past-due value", () => {
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ status: "active", customer: "a", ...seats(5) }),
        subscription({ status: "past_due", customer: "b", ...seats(5) }),
      ]),
    });
    expect(data(result.health).mrrCents).toBe(10_500);
    expect(data(result.pastDueSubscriptions).totalCents).toBe(10_500);
  });
});

describe("past-due subscriptions", () => {
  it("counts past_due only, at the RAW unit amount with no monthly normalization", () => {
    // The next cycle's value: a yearly plan of 1200.00 is 1200.00 here and 100.00 of MRR.
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ status: "past_due", customer: "cus_a", ...price(1_200_00, "year") }),
        subscription({ status: "active", customer: "cus_b", ...price(1_200_00, "year") }),
      ]),
    });
    expect(data(result.pastDueSubscriptions)).toMatchObject({ count: 1, totalCents: 1_200_00 });
    expect(data(result.health).mrrCents).toBe(10_000);
  });
});

describe("the Card Updater advisory", () => {
  it("fires only when zero events AND the declines clear the threshold", () => {
    expect(buildCardUpdaterAdvisory(1, 99)).toBeNull();
    expect(buildCardUpdaterAdvisory(0, MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY - 1)).toBeNull();
    expect(buildCardUpdaterAdvisory(0, MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY)).toContain(
      "Stripe Account Updater is not firing",
    );
  });

  it("COUNTS ITS DENOMINATOR INSIDE THE 30-DAY WINDOW, not the 90-day lookback", () => {
    // Stripe keeps events 30 days, so declines are counted in that window, not the 90-day lookback.
    const expired = { last_finalization_error: { decline_code: "expired_card" } };
    const result = audit({
      uncollectibleInvoices: ok<Stripe.Invoice>([
        invoice({ amount_due: 1, created: secondsAt(10 * DAY), ...expired }),
        invoice({ amount_due: 1, created: secondsAt(60 * DAY), ...expired }),
        invoice({ amount_due: 1, created: secondsAt(61 * DAY), ...expired }),
        invoice({ amount_due: 1, created: secondsAt(62 * DAY), ...expired }),
      ]),
    });
    expect(data(result.cardUpdater).expiredCardDeclinesInWindow).toBe(1);
    expect(data(result.cardUpdater).windowDays).toBe(30);
    expect(data(result.cardUpdater).advisory).toBeNull();
  });
});

describe("disputes", () => {
  it("open is needs_response or under_review, and accepted is LOST WITH ZERO SUBMISSIONS", () => {
    const result = audit({
      disputes: ok<Stripe.Dispute>([
        dispute({ status: "needs_response", amount: 100 }),
        dispute({ status: "under_review", amount: 200 }),
        dispute({ status: "lost", amount: 400, evidence_details: { submission_count: 0 } }),
        dispute({ status: "lost", amount: 800, evidence_details: { submission_count: 1 } }),
        dispute({ status: "won", amount: 1_600 }),
      ]),
    });
    const scope = data(result.disputes);
    expect(scope.open).toMatchObject({ count: 2, totalCents: 300 });
    expect(scope.acceptedWithoutFighting).toMatchObject({ count: 1, totalCents: 400 });
    expect(scope.historical).toEqual({ won: 1, lost: 2 });
  });
});

describe("health", () => {
  it("MRR from active subs, ARR twelve times it, and churn in basis points", () => {
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ status: "active", customer: "a", ...price(10_000, "month") }),
        subscription({ status: "past_due", customer: "b", ...price(10_000, "month") }),
        subscription({
          status: "canceled",
          customer: "c",
          canceled_at: secondsAt(10 * DAY),
          cancellation_details: { reason: "cancellation_requested" },
          ...price(10_000, "month"),
        }),
        subscription({
          status: "canceled",
          customer: "d",
          canceled_at: secondsAt(10 * DAY),
          cancellation_details: { reason: "payment_failed" },
          ...price(10_000, "month"),
        }),
      ]),
    });
    const scope = data(result.health);
    expect(scope.mrrCents).toBe(10_000);
    expect(scope.arrCents).toBe(120_000);
    expect(scope.activeSubscriptionsCount).toBe(1);
    // A payment-failed cancellation is not voluntary churn.
    expect(scope.voluntaryChurnRateBps).toBe(2_500);
    expect(scope.involuntaryChurnRateBps).toBe(2_500);
  });

  it("involuntary churn is payment-failed or disputed cancellations, not the past-due share", () => {
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ status: "active", customer: "a", ...price(10_000, "month") }),
        subscription({
          status: "canceled",
          customer: "b",
          canceled_at: secondsAt(10 * DAY),
          cancellation_details: { reason: "payment_failed" },
          ...price(10_000, "month"),
        }),
      ]),
    });
    expect(data(result.health).involuntaryChurnRateBps).toBe(5_000);
    expect(data(result.health).voluntaryChurnRateBps).toBe(0);
  });

  it("a cancellation OUTSIDE the lookback is not churn in this window", () => {
    const result = audit(
      {
        subscriptions: ok<Stripe.Subscription>([
          subscription({
            status: "canceled",
            customer: "old",
            canceled_at: secondsAt(120 * DAY),
            cancellation_details: { reason: "cancellation_requested" },
            ...price(10_000, "month"),
          }),
        ]),
      },
      90,
    );
    expect(data(result.health).voluntaryChurnRateBps).toBe(0);
  });
});

describe("per-scope status: a zero never means unknown", () => {
  it("the subscriptions read fails THREE scopes, because three depend on it", () => {
    const result = audit({ subscriptions: failed("subs unavailable") });
    expect(result.expiringCards.ok).toBe(false);
    expect(result.pastDueSubscriptions.ok).toBe(false);
    expect(result.health.ok).toBe(false);
    expect(result.failedInvoices.ok).toBe(true);
    expect(result.disputes.ok).toBe(true);
  });

  it("either invoice read failing fails the invoice scope and the advisory; a failed events read only the advisory", () => {
    // Half a failed set is worse than none: it would report the other half as the whole picture.
    const result = audit({ openInvoices: failed("open invoices unavailable") });
    expect(result.failedInvoices).toEqual({ ok: false, reason: "open invoices unavailable" });
    expect(result.cardUpdater).toEqual({ ok: false, reason: "open invoices unavailable" });
    const events = audit({ cardUpdaterEvents: failed("events unavailable") });
    expect(events.cardUpdater).toEqual({ ok: false, reason: "events unavailable" });
    expect(events.failedInvoices.ok).toBe(true);
  });
});

describe("the summary", () => {
  it("a failed call and an empty reply both fall back with the reason", async () => {
    const env = { ANTHROPIC_API_KEY: "sk" } as unknown as Env;
    const summaryWith = async (reply: unknown) => {
      vi.doMock("~/lib/ai/client", () => ({
        REWRITE: { maxAttempts: 1 },
        askModel: () => Promise.resolve(reply),
      }));
      vi.resetModules();
      return (await import("~/lib/audit/summary.server")).generateAuditSummary(env, audit());
    };
    expect(await summaryWith({ ok: false, kind: "unavailable" })).toEqual({
      source: "fallback",
      summary: AUDIT_SUMMARY_FALLBACK,
      reason: "the model call failed: unavailable",
    });
    expect(await summaryWith({ ok: true, text: "   " })).toEqual({
      source: "fallback",
      summary: AUDIT_SUMMARY_FALLBACK,
      reason: "the model returned no text",
    });
    vi.doUnmock("~/lib/ai/client");
    vi.resetModules();
  });

  it("wide dashes in the model's reply become commas before it is stored", () => {
    const EM = String.fromCharCode(0x2014);
    const EN = String.fromCharCode(0x2013);
    expect(sanitizeSummary(`a${EM}b`)).toBe("a, b");
    expect(sanitizeSummary(`a${EN}b`)).toBe("a, b");
    expect(sanitizeSummary("  clean  ")).toBe("clean");
  });
});
