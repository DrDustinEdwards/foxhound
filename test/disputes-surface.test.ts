import { describe, expect, it } from "vitest";

import { deadlineUrgency } from "~/lib/disputes/labels";
import { buildDisputeTimeline } from "~/lib/disputes/timeline";

const NOW = Date.parse("2026-07-25T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;

describe("deadline urgency", () => {
  it("bands at the 3 and 7 day boundaries", () => {
    expect(deadlineUrgency(0)).toBe("overdue");
    expect(deadlineUrgency(-2)).toBe("overdue");
    expect(deadlineUrgency(1)).toBe("urgent");
    expect(deadlineUrgency(3)).toBe("urgent");
    expect(deadlineUrgency(4)).toBe("soon");
    expect(deadlineUrgency(7)).toBe("soon");
    expect(deadlineUrgency(8)).toBe("normal");
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
  };

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
