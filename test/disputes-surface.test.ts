import { describe, expect, it } from "vitest";

import {
  daysUntilDeadline,
  deadlineLabel,
  deadlineUrgency,
  humanizeDisputeReason,
} from "~/lib/disputes/labels";
import { buildDisputeTimeline } from "~/lib/disputes/timeline";

const NOW = Date.parse("2026-07-25T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;

describe("humanizeDisputeReason", () => {

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

  it("phrases the remaining time, singular at one day", () => {
    expect(deadlineLabel(1)).toBe("1 day left");
    expect(deadlineLabel(5)).toBe("5 days left");
    expect(deadlineLabel(0)).toBe("Deadline passed");
  });
});

// computeDisputeStats is pinned in test/disputes-list-j66.test.ts (J66): its
// totals are per currency, and the Win rate card it feeds stays, Dustin's
// approved difference (PR #75 question 4, "yes ro all", 2026-10-15).

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
    });
    const ruling = items.at(-1)!;
    expect(ruling.at?.getTime()).toBe(NOW + 4 * day);
    expect(ruling.label).toBe("Bank ruled: WON. Funds retained.");
  });

  it("credits an external submitter correctly", () => {
    const items = buildDisputeTimeline({
      ...base,
      submittedAt: new Date(NOW + day),
      submittedBy: "merchant_or_stripe",
      state: "submitted",
    });
    expect(items.at(-1)!.label).toContain("externally (merchant or Stripe)");
  });
});
