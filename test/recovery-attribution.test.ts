import { describe, expect, it } from "vitest";

import {
  ATTRIBUTION_KINDS,
  BILLABLE_ATTRIBUTION_KINDS,
  EMAIL_ENGAGEMENT_WINDOW_MS,
  MANUAL_ATTRIBUTION_KIND,
} from "~/lib/constants";
import {
  type AttributionStepRow,
  findAttributionSignals,
  resolveAttribution,
} from "~/lib/recovery/attribution";

describe("resolveAttribution", () => {
  it("every attribution kind is CONSCIOUSLY classified billable or free", () => {
    // The two sets partition ATTRIBUTION_KINDS, so a new kind cannot ship unclassified.
    const FREE_ATTRIBUTION_KINDS = ["stripe_baseline", MANUAL_ATTRIBUTION_KIND];
    expect([...BILLABLE_ATTRIBUTION_KINDS, ...FREE_ATTRIBUTION_KINDS].sort()).toEqual(
      [...ATTRIBUTION_KINDS].sort(),
    );
    // Disjoint, so a kind cannot be quietly counted as both.
    for (const kind of FREE_ATTRIBUTION_KINDS) {
      expect([...BILLABLE_ATTRIBUTION_KINDS]).not.toContain(kind);
    }
  });
});

// The recovery instant the signals are resolved against, inside the engagement window.
const RECOVERED_AT = new Date("2026-07-05T00:00:00.000Z");

describe("findAttributionSignals (webhooks/process.ts's read of recovery_steps)", () => {
  const step = (over: Partial<AttributionStepRow>): AttributionStepRow => ({
    id: "step_x",
    stepType: "email_day1",
    result: null,
    clickedAt: null,
    ...over,
  });

  it("a completed card_update step produces cardUpdateRef -> attribution_kind card_update", () => {
    const steps = [
      step({ id: "step_1", stepType: "email_day1", result: "email_sent" }),
      step({ id: "step_2", stepType: "card_update", result: "card_updated" }),
    ];
    const signals = findAttributionSignals(steps, RECOVERED_AT);
    expect(signals.cardUpdateRef).toBe("step_2");
    expect(resolveAttribution(signals)).toEqual({ kind: "card_update", ref: "step_2" });
  });

  it("a card update made after the customer already paid is not a signal", () => {
    const steps = [
      step({
        id: "step_late",
        stepType: "card_update",
        result: "card_updated",
        executedAt: new Date(RECOVERED_AT.getTime() + 60_000),
      }),
    ];
    expect(resolveAttribution(findAttributionSignals(steps, RECOVERED_AT))).toEqual({
      kind: "stripe_baseline",
      ref: null,
    });
  });

  it("the latest click wins whatever the row order, so the ledger cites the click that preceded the payment", () => {
    const early = step({ id: "step_early", clickedAt: new Date("2026-07-01T00:00:00.000Z") });
    const late = step({ id: "step_late", clickedAt: new Date("2026-07-04T00:00:00.000Z") });
    expect(findAttributionSignals([early, late], RECOVERED_AT).clickedEngagementId).toBe(
      "step_late",
    );
    expect(findAttributionSignals([late, early], RECOVERED_AT).clickedEngagementId).toBe(
      "step_late",
    );
  });

  it("a click after the payment, or older than the engagement window, is not a signal", () => {
    const after = step({ id: "after", clickedAt: new Date(RECOVERED_AT.getTime() + 60_000) });
    const stale = step({
      id: "stale",
      clickedAt: new Date(RECOVERED_AT.getTime() - EMAIL_ENGAGEMENT_WINDOW_MS - 60_000),
    });
    expect(findAttributionSignals([after, stale], RECOVERED_AT).clickedEngagementId).toBeNull();
  });

  it("an incomplete card_update step (no result yet) is not a signal", () => {
    const steps = [step({ id: "step_1", stepType: "card_update", result: null })];
    expect(findAttributionSignals(steps, RECOVERED_AT).cardUpdateRef).toBeNull();
    expect(resolveAttribution(findAttributionSignals(steps, RECOVERED_AT))).toEqual({
      kind: "stripe_baseline",
      ref: null,
    });
  });
});
