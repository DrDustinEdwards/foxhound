import { describe, expect, it } from "vitest";

import {
  buildCustomerContextFields,
  buildDisputeSignals,
  buildEngagementSignals,
  buildRecoverySignals,
  collapseBillingObservations,
  computePaymentLatencyDriftDays,
  computeSubscriptionAgeDays,
  countBillingChanges,
  monthlyEquivalentCents,
  summarizeActiveSubscriptions,
} from "~/lib/intelligence/signals";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("monthlyEquivalentCents", () => {
  it("passes monthly amounts through unchanged", () => {
    expect(monthlyEquivalentCents(2000, 1, "month")).toBe(2000);
  });
  it("divides annual amounts by 12", () => {
    expect(monthlyEquivalentCents(12000, 1, "year")).toBe(1000);
  });
  it("scales weekly amounts by 52/12", () => {
    expect(monthlyEquivalentCents(1000, 1, "week")).toBe(Math.round(1000 * (52 / 12)));
  });
  it("multiplies by quantity (seats)", () => {
    expect(monthlyEquivalentCents(1000, 5, "month")).toBe(5000);
  });
});

describe("summarizeActiveSubscriptions", () => {
  it("is an honest zero for no subscriptions", () => {
    expect(summarizeActiveSubscriptions([])).toEqual({
      mrrContributionCents: 0,
      activeSubscriptionsCount: 0,
      currentPlanName: null,
    });
  });

  it("sums monthly-equivalent MRR across subscriptions", () => {
    const result = summarizeActiveSubscriptions([
      { priceId: "p1", productName: "Starter", quantity: 1, interval: "month", unitAmountCents: 2000 },
      { priceId: "p2", productName: "Addon", quantity: 1, interval: "year", unitAmountCents: 12000 },
    ]);
    expect(result.mrrContributionCents).toBe(2000 + 1000);
    expect(result.activeSubscriptionsCount).toBe(2);
  });

  it("picks the plan with the largest MRR contribution as current", () => {
    const result = summarizeActiveSubscriptions([
      { priceId: "p1", productName: "Small", quantity: 1, interval: "month", unitAmountCents: 500 },
      { priceId: "p2", productName: "Big", quantity: 1, interval: "month", unitAmountCents: 5000 },
    ]);
    expect(result.currentPlanName).toBe("Big");
  });
});

describe("computeSubscriptionAgeDays", () => {
  it("computes whole days elapsed", () => {
    const since = new Date("2026-01-01T00:00:00.000Z").getTime();
    const now = new Date("2026-01-11T00:00:00.000Z").getTime();
    expect(computeSubscriptionAgeDays(since, now)).toBe(10);
  });
  it("clamps a future customerSince to zero, never negative", () => {
    const since = new Date("2026-02-01T00:00:00.000Z").getTime();
    const now = new Date("2026-01-01T00:00:00.000Z").getTime();
    expect(computeSubscriptionAgeDays(since, now)).toBe(0);
  });
});

describe("countBillingChanges", () => {
  it("a single observation has zero changes (baseline, not a change)", () => {
    expect(
      countBillingChanges([{ at: 1, priceId: "p1", quantity: 1, interval: "month" }]),
    ).toEqual({ planChangeCount: 0, seatChangeCount: 0, intervalSwitchCount: 0 });
  });

  it("counts a plan (price) change", () => {
    const result = countBillingChanges([
      { at: 1, priceId: "p1", quantity: 1, interval: "month" },
      { at: 2, priceId: "p2", quantity: 1, interval: "month" },
    ]);
    expect(result).toEqual({ planChangeCount: 1, seatChangeCount: 0, intervalSwitchCount: 0 });
  });

  it("counts a seat (quantity) change independently of plan", () => {
    const result = countBillingChanges([
      { at: 1, priceId: "p1", quantity: 1, interval: "month" },
      { at: 2, priceId: "p1", quantity: 3, interval: "month" },
    ]);
    expect(result).toEqual({ planChangeCount: 0, seatChangeCount: 1, intervalSwitchCount: 0 });
  });

  it("counts an interval switch (e.g. annual -> monthly)", () => {
    const result = countBillingChanges([
      { at: 1, priceId: "p1", quantity: 1, interval: "year" },
      { at: 2, priceId: "p1", quantity: 1, interval: "month" },
    ]);
    expect(result).toEqual({ planChangeCount: 0, seatChangeCount: 0, intervalSwitchCount: 1 });
  });

  it("sorts by time before diffing, regardless of input order", () => {
    const result = countBillingChanges([
      { at: 2, priceId: "p2", quantity: 1, interval: "month" },
      { at: 1, priceId: "p1", quantity: 1, interval: "month" },
    ]);
    expect(result.planChangeCount).toBe(1);
  });

  it("counts every transition across a longer history, not just the endpoints", () => {
    const result = countBillingChanges([
      { at: 1, priceId: "p1", quantity: 1, interval: "month" },
      { at: 2, priceId: "p2", quantity: 1, interval: "month" },
      { at: 3, priceId: "p1", quantity: 1, interval: "month" },
    ]);
    expect(result.planChangeCount).toBe(2);
  });
});

describe("collapseBillingObservations (construction layer: raw Stripe lines -> one state per instant)", () => {
  it("collapses a multi-item subscription (base + addon, same instant) to a single observation", () => {
    const collapsed = collapseBillingObservations([
      { at: 1000, priceId: "base", quantity: 1, interval: "month", valueCents: 5000 },
      { at: 1000, priceId: "addon", quantity: 3, interval: "month", valueCents: 1500 },
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toEqual({ at: 1000, priceId: "base", quantity: 1, interval: "month" });
  });

  it("picks the highest-value line as the representative, regardless of input order", () => {
    const collapsed = collapseBillingObservations([
      { at: 1000, priceId: "addon", quantity: 3, interval: "month", valueCents: 1500 },
      { at: 1000, priceId: "base", quantity: 1, interval: "month", valueCents: 5000 },
    ]);
    expect(collapsed[0].priceId).toBe("base");
  });

  it("a proration credit (negative valueCents) never wins over the real charge line at the same instant", () => {
    const collapsed = collapseBillingObservations([
      { at: 2000, priceId: "old_plan", quantity: 1, interval: "month", valueCents: -2000 },
      { at: 2000, priceId: "new_plan", quantity: 1, interval: "month", valueCents: 9000 },
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].priceId).toBe("new_plan");
  });

  it("leaves distinct instants alone (nothing to collapse when timestamps differ)", () => {
    const collapsed = collapseBillingObservations([
      { at: 1000, priceId: "p1", quantity: 1, interval: "month", valueCents: 5000 },
      { at: 2000, priceId: "p2", quantity: 1, interval: "month", valueCents: 5000 },
    ]);
    expect(collapsed).toHaveLength(2);
  });

  it("a multi-item subscription observed once, then fed through countBillingChanges, registers ZERO spurious changes", () => {
    const raw = [
      { at: 1000, priceId: "base", quantity: 1, interval: "month" as const, valueCents: 5000 },
      { at: 1000, priceId: "addon", quantity: 3, interval: "month" as const, valueCents: 1500 },
    ];
    const result = countBillingChanges(collapseBillingObservations(raw));
    expect(result).toEqual({ planChangeCount: 0, seatChangeCount: 0, intervalSwitchCount: 0 });
  });

  it("an upgrade invoice (proration credit + new charge, same instant) registers exactly the ONE real plan change, not a phantom double-count from its own two lines", () => {
    // Reproduces the pre-fix bug directly: without collapsing, sorting by time
    // is a stable sort, so ties keep insertion order. Pushing the new charge
    // BEFORE the proration credit at the same timestamp used to diff as
    // p1 -> p2 -> p1 (two spurious changes) instead of the one real p1 -> p2
    // change against the subscription's own earlier, distinct-timestamp state.
    const raw = [
      { at: 1000, priceId: "p1", quantity: 1, interval: "month" as const, valueCents: 5000 }, // subscription created on plan p1
      { at: 2000, priceId: "p2", quantity: 1, interval: "month" as const, valueCents: 9000 }, // upgrade invoice: new charge
      { at: 2000, priceId: "p1", quantity: 1, interval: "month" as const, valueCents: -2000 }, // upgrade invoice: proration credit for p1
    ];
    const result = countBillingChanges(collapseBillingObservations(raw));
    expect(result).toEqual({ planChangeCount: 1, seatChangeCount: 0, intervalSwitchCount: 0 });
  });
});

describe("computePaymentLatencyDriftDays", () => {
  it("returns null with fewer than two datable invoices (not a fabricated zero)", () => {
    expect(computePaymentLatencyDriftDays([])).toBeNull();
    expect(computePaymentLatencyDriftDays([{ dueAt: 1, paidAt: 2 }])).toBeNull();
  });

  it("returns null when due/paid dates are missing entirely", () => {
    expect(
      computePaymentLatencyDriftDays([
        { dueAt: null, paidAt: null },
        { dueAt: null, paidAt: 1 },
      ]),
    ).toBeNull();
  });

  it("is zero when lateness is constant across history", () => {
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const invoices = [0, 1, 2, 3].map((i) => ({
      dueAt: base + i * 30 * DAY_MS,
      paidAt: base + i * 30 * DAY_MS + 2 * DAY_MS,
    }));
    expect(computePaymentLatencyDriftDays(invoices)).toBe(0);
  });

  it("is positive when payments trend later over time", () => {
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const invoices = [
      { dueAt: base, paidAt: base }, // on time
      { dueAt: base + 30 * DAY_MS, paidAt: base + 30 * DAY_MS }, // on time
      { dueAt: base + 60 * DAY_MS, paidAt: base + 60 * DAY_MS + 10 * DAY_MS }, // 10 days late
      { dueAt: base + 90 * DAY_MS, paidAt: base + 90 * DAY_MS + 10 * DAY_MS }, // 10 days late
    ];
    expect(computePaymentLatencyDriftDays(invoices)).toBeGreaterThan(0);
  });

  it("is negative when payments trend earlier (improving)", () => {
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const invoices = [
      { dueAt: base, paidAt: base + 10 * DAY_MS },
      { dueAt: base + 30 * DAY_MS, paidAt: base + 30 * DAY_MS + 10 * DAY_MS },
      { dueAt: base + 60 * DAY_MS, paidAt: base + 60 * DAY_MS },
      { dueAt: base + 90 * DAY_MS, paidAt: base + 90 * DAY_MS },
    ];
    expect(computePaymentLatencyDriftDays(invoices)).toBeLessThan(0);
  });
});

describe("buildRecoverySignals", () => {
  it("is an honest all-zero/null for a customer with no failed-payment history", () => {
    expect(buildRecoverySignals([])).toEqual({
      failedPaymentCount: 0,
      recoveredCount: 0,
      avgDaysToRecover: null,
    });
  });

  it("counts recovered vs total and averages days-to-recover over recovered rows only", () => {
    const result = buildRecoverySignals([
      { status: "recovered", daysToRecover: 2 },
      { status: "recovered", daysToRecover: 4 },
      { status: "active", daysToRecover: null },
    ]);
    expect(result).toEqual({ failedPaymentCount: 3, recoveredCount: 2, avgDaysToRecover: 3 });
  });
});

describe("buildDisputeSignals", () => {
  it("is an honest zero for a customer with no disputes", () => {
    expect(buildDisputeSignals([])).toEqual({ disputeCount: 0, wonCount: 0, lostCount: 0 });
  });
  it("splits won vs lost", () => {
    expect(
      buildDisputeSignals([{ state: "resolved_won" }, { state: "resolved_lost" }, { state: "pending_review" }]),
    ).toEqual({ disputeCount: 3, wonCount: 1, lostCount: 1 });
  });
});

describe("buildEngagementSignals", () => {
  it("is an honest zero/null for a customer with no engagement events", () => {
    expect(buildEngagementSignals([])).toEqual({ openCount: 0, clickCount: 0, lastEngagedAtMs: null });
  });
  it("counts opens/clicks and finds the most recent engagement", () => {
    const result = buildEngagementSignals([
      { eventType: "open", occurredAt: 100 },
      { eventType: "click", occurredAt: 300 },
      { eventType: "open", occurredAt: 200 },
    ]);
    expect(result).toEqual({ openCount: 2, clickCount: 1, lastEngagedAtMs: 300 });
  });
});

describe("buildCustomerContextFields (orchestrator)", () => {
  const now = new Date("2026-07-19T00:00:00.000Z").getTime();
  const since = new Date("2026-01-01T00:00:00.000Z").getTime();

  it("combines every sub-signal for an active, engaged customer", () => {
    const result = buildCustomerContextFields({
      customerSinceMs: since,
      nowMs: now,
      activeSubscriptions: [
        { priceId: "p1", productName: "Pro", quantity: 2, interval: "month", unitAmountCents: 3000 },
      ],
      billingHistory: [
        { at: since, priceId: "p0", quantity: 1, interval: "month", valueCents: 3000 },
        { at: since + 30 * DAY_MS, priceId: "p1", quantity: 2, interval: "month", valueCents: 6000 },
      ],
      invoiceHistory: [],
      refundCount: 1,
      disputeCount: 0,
      recoveryRows: [{ status: "recovered", daysToRecover: 3 }],
      disputeRows: [],
      engagementRows: [{ eventType: "click", occurredAt: 500 }],
    });

    expect(result.mrrContributionCents).toBe(6000);
    expect(result.activeSubscriptionsCount).toBe(1);
    expect(result.currentPlanName).toBe("Pro");
    expect(result.planChangeCount).toBe(1);
    expect(result.refundCount).toBe(1);
    expect(result.paymentLatencyDriftDays).toBeNull();
    expect(result.recoverySignals).toEqual({ failedPaymentCount: 1, recoveredCount: 1, avgDaysToRecover: 3 });
    expect(result.engagementSignals.clickCount).toBe(1);
  });

  it("a multi-item subscription (base + addon, one instant) produces zero spurious plan/seat/interval changes", () => {
    const result = buildCustomerContextFields({
      customerSinceMs: since,
      nowMs: now,
      activeSubscriptions: [
        { priceId: "base", productName: "Pro", quantity: 1, interval: "month", unitAmountCents: 5000 },
        { priceId: "addon", productName: "Seats add-on", quantity: 3, interval: "month", unitAmountCents: 500 },
      ],
      billingHistory: [
        { at: since, priceId: "base", quantity: 1, interval: "month", valueCents: 5000 },
        { at: since, priceId: "addon", quantity: 3, interval: "month", valueCents: 1500 },
      ],
      invoiceHistory: [],
      refundCount: 0,
      disputeCount: 0,
      recoveryRows: [],
      disputeRows: [],
      engagementRows: [],
    });
    expect(result.planChangeCount).toBe(0);
    expect(result.seatChangeCount).toBe(0);
    expect(result.intervalSwitchCount).toBe(0);
  });

  it("a proration/upgrade invoice (credit + new charge, one instant) registers exactly one real plan change", () => {
    const result = buildCustomerContextFields({
      customerSinceMs: since,
      nowMs: now,
      activeSubscriptions: [
        { priceId: "p2", productName: "Growth", quantity: 1, interval: "month", unitAmountCents: 9000 },
      ],
      billingHistory: [
        { at: since, priceId: "p1", quantity: 1, interval: "month", valueCents: 5000 },
        { at: since + 30 * DAY_MS, priceId: "p2", quantity: 1, interval: "month", valueCents: 9000 },
        { at: since + 30 * DAY_MS, priceId: "p1", quantity: 1, interval: "month", valueCents: -2000 },
      ],
      invoiceHistory: [],
      refundCount: 0,
      disputeCount: 0,
      recoveryRows: [],
      disputeRows: [],
      engagementRows: [],
    });
    expect(result.planChangeCount).toBe(1);
    expect(result.seatChangeCount).toBe(0);
  });

  it("is a full honest-zero row for a brand new customer with no active subscription", () => {
    const result = buildCustomerContextFields({
      customerSinceMs: now,
      nowMs: now,
      activeSubscriptions: [],
      billingHistory: [],
      invoiceHistory: [],
      refundCount: 0,
      disputeCount: 0,
      recoveryRows: [],
      disputeRows: [],
      engagementRows: [],
    });

    expect(result.mrrContributionCents).toBe(0);
    expect(result.activeSubscriptionsCount).toBe(0);
    expect(result.currentPlanName).toBeNull();
    expect(result.subscriptionAgeDays).toBe(0);
    expect(result.planChangeCount).toBe(0);
  });

  it("never sets healthScore/aiAssessment fields (not part of this shape at all)", () => {
    const result = buildCustomerContextFields({
      customerSinceMs: since,
      nowMs: now,
      activeSubscriptions: [],
      billingHistory: [],
      invoiceHistory: [],
      refundCount: 0,
      disputeCount: 0,
      recoveryRows: [],
      disputeRows: [],
      engagementRows: [],
    });
    expect(result).not.toHaveProperty("healthScore");
    expect(result).not.toHaveProperty("aiAssessment");
    expect(result).not.toHaveProperty("aiRecommendedActions");
  });
});
