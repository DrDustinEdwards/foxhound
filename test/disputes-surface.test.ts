import { describe, expect, it } from "vitest";

import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import {
  daysUntilDeadline,
  deadlineClassName,
  deadlineLabel,
  deadlineUrgency,
  humanizeDisputeReason,
} from "~/lib/disputes/labels";
import { computeDisputeStats, type DisputeStatsInput } from "~/lib/disputes/stats";
import { buildDisputeTimeline } from "~/lib/disputes/timeline";

const NOW = Date.parse("2026-07-25T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;

describe("humanizeDisputeReason", () => {
  // Both surfaces rendered the raw enum, so a merchant reviewing a chargeback
  // saw "product_not_received" in a column headed Reason.
  it("maps Stripe's reason codes to readable labels", () => {
    expect(humanizeDisputeReason("product_not_received")).toBe("Product not received");
    expect(humanizeDisputeReason("subscription_canceled")).toBe("Subscription canceled");
    expect(humanizeDisputeReason("fraudulent")).toBe("Fraudulent");
  });

  it("falls back to a de-underscored label for an unmapped code", () => {
    expect(humanizeDisputeReason("some_new_reason")).toBe("Some new reason");
  });

  // Legacy capitalized the first character and de-underscored only the REST, so
  // a leading underscore survived into the UI.
  it("de-underscores the whole string, including a leading underscore", () => {
    expect(humanizeDisputeReason("_odd_code")).toBe("Odd code");
  });

  it("says Unknown for a null or empty reason", () => {
    expect(humanizeDisputeReason(null)).toBe("Unknown");
    expect(humanizeDisputeReason("")).toBe("Unknown");
  });
});

describe("deadline urgency", () => {
  it("counts whole days remaining, rounding up", () => {
    expect(daysUntilDeadline(new Date(NOW + 3 * day), NOW)).toBe(3);
    expect(daysUntilDeadline(new Date(NOW + 2.4 * day), NOW)).toBe(3);
  });

  it("passes null through for a dispute with no deadline", () => {
    expect(daysUntilDeadline(null, NOW)).toBeNull();
    expect(deadlineUrgency(null)).toBe("normal");
    expect(deadlineLabel(null)).toBeNull();
  });

  it("bands at the 3 and 7 day boundaries", () => {
    expect(deadlineUrgency(0)).toBe("overdue");
    expect(deadlineUrgency(-2)).toBe("overdue");
    expect(deadlineUrgency(1)).toBe("urgent");
    expect(deadlineUrgency(3)).toBe("urgent");
    expect(deadlineUrgency(4)).toBe("soon");
    expect(deadlineUrgency(7)).toBe("soon");
    expect(deadlineUrgency(8)).toBe("normal");
  });

  it("tones urgent red, soon amber, and normal plain", () => {
    expect(deadlineClassName("overdue")).toBe("text-error-text");
    expect(deadlineClassName("urgent")).toBe("text-error-text");
    expect(deadlineClassName("soon")).toBe("text-amber-text");
    expect(deadlineClassName("normal")).toBe("text-text-tertiary");
  });

  it("phrases the remaining time, singular at one day", () => {
    expect(deadlineLabel(1)).toBe("1 day left");
    expect(deadlineLabel(5)).toBe("5 days left");
    expect(deadlineLabel(0)).toBe("Deadline passed");
  });
});

describe("computeDisputeStats", () => {
  const row = (o: Partial<DisputeStatsInput> = {}): DisputeStatsInput => ({
    state: "pending_review",
    amountCents: 10_000,
    resolvedFeeCents: null,
    submittedAt: null,
    ...o,
  });

  it("counts unresolved disputes and the money in play", () => {
    const stats = computeDisputeStats([
      row({ state: "draft", amountCents: 5_000 }),
      row({ state: "pending_review", amountCents: 7_000 }),
      row({ state: "resolved_won", amountCents: 100_000 }),
    ]);
    expect(stats.needsActionCount).toBe(2);
    expect(stats.atStakeCents).toBe(12_000);
  });

  // 0% won and "nothing has resolved" are different claims.
  it("reports a null win rate until something resolves", () => {
    const stats = computeDisputeStats([row({ state: "draft" })]);
    expect(stats.winRatePct).toBeNull();
  });

  it("computes the win rate over resolved disputes only", () => {
    const stats = computeDisputeStats([
      row({ state: "resolved_won", submittedAt: new Date(NOW) }),
      row({ state: "resolved_lost" }),
      row({ state: "resolved_lost" }),
      row({ state: "draft" }),
    ]);
    expect(stats.winRatePct).toBe(33);
    expect(stats.wonCount).toBe(1);
    expect(stats.lostCount).toBe(2);
  });

  // PRICING.md rev 3: billable only when Foxhound drafted AND submitted. A
  // merchant-fought win is a win with no fee.
  it("bills no fee on a win Foxhound did not submit", () => {
    const stats = computeDisputeStats([
      row({ state: "resolved_won", amountCents: 10_000, submittedAt: null }),
    ]);
    expect(stats.wonCount).toBe(1);
    expect(stats.feesOwedCents).toBe(0);
  });

  it("prefers the stored resolved fee over a projection", () => {
    const stats = computeDisputeStats([
      row({ state: "resolved_won", amountCents: 10_000, resolvedFeeCents: 1_234, submittedAt: new Date(NOW) }),
    ]);
    expect(stats.feesOwedCents).toBe(1_234);
  });

  it("projects 20% when no fee has been stamped yet", () => {
    const stats = computeDisputeStats([
      row({ state: "resolved_won", amountCents: 10_000, submittedAt: new Date(NOW) }),
    ]);
    expect(stats.feesOwedCents).toBe(2_000);
  });

  // Legacy's replaced card used a hardcoded 10% with no cap, so a won $10,000
  // dispute reported $1,000 where the real capped fee is $500.
  it("honors the $500 cap on a large win", () => {
    const stats = computeDisputeStats([
      row({ state: "resolved_won", amountCents: 1_000_000, submittedAt: new Date(NOW) }),
    ]);
    expect(stats.feesOwedCents).toBe(DISPUTE_FEE_CAP_CENTS);
    expect(stats.feesOwedCents).toBeLessThan(200_000);
  });

  it("reports zeros for an empty set", () => {
    const stats = computeDisputeStats([]);
    expect(stats).toMatchObject({ needsActionCount: 0, atStakeCents: 0, feesOwedCents: 0, winRatePct: null });
  });
});

describe("buildDisputeTimeline", () => {
  const base = {
    createdAt: new Date(NOW),
    amountCents: 9_900,
    currency: "usd",
    reason: "product_not_received",
    aiGeneratedAt: null,
    stagedAt: null,
    submittedAt: null,
    submittedBy: null,
    outcomeNotifiedAt: null,
    resolvedAt: null,
    state: "pending_review",
    resolvedFeeCents: null,
  };

  it("always opens with the dispute being received, humanizing the reason", () => {
    const items = buildDisputeTimeline(base);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("Dispute received. $99.00 for Product not received.");
  });

  // Legacy appended in source order and never sorted, so a staged_at backfilled
  // after submitted_at rendered out of sequence.
  it("sorts by timestamp rather than by source order", () => {
    const items = buildDisputeTimeline({
      ...base,
      submittedAt: new Date(NOW + 2 * day),
      stagedAt: new Date(NOW + 5 * day), // later than the submission
      state: "submitted",
    });
    const times = items.map((i) => i.at?.getTime() ?? 0);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  // Legacy gave the ruling the notification's timestamp, so both rows printed
  // the same time.
  it("anchors the ruling to resolved_at, not to the notification", () => {
    const items = buildDisputeTimeline({
      ...base,
      submittedAt: new Date(NOW + day),
      outcomeNotifiedAt: new Date(NOW + 3 * day),
      resolvedAt: new Date(NOW + 4 * day),
      state: "resolved_won",
      resolvedFeeCents: 1_980,
    });
    const ruling = items.at(-1)!;
    expect(ruling.at?.getTime()).toBe(NOW + 4 * day);
    expect(ruling.label).toContain("in your favor");
    expect(ruling.label).toContain("$19.80");
  });

  it("states plainly that an unsubmitted win carries no fee", () => {
    const items = buildDisputeTimeline({
      ...base,
      resolvedAt: new Date(NOW + day),
      state: "resolved_won",
      resolvedFeeCents: null,
    });
    expect(items.at(-1)!.label).toContain("No fee");
  });

  it("says a loss is not billed", () => {
    const items = buildDisputeTimeline({ ...base, resolvedAt: new Date(NOW + day), state: "resolved_lost" });
    expect(items.at(-1)!.label).toContain("Not billed");
  });

  it("credits an external submitter correctly", () => {
    const items = buildDisputeTimeline({
      ...base,
      submittedAt: new Date(NOW + day),
      submittedBy: "merchant_or_stripe",
      state: "submitted",
    });
    expect(items.at(-1)!.label).toContain("the merchant or Stripe");
  });
});
