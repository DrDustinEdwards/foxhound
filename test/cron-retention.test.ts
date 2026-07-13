import { describe, expect, it } from "vitest";

import { computeAiCallCostCents } from "~/lib/ai/cost";
import { aggregateAiCalls, cutoffFor, monthKeyUTC, type AiCallRow } from "~/lib/cron/retention";
import { DAY_MS } from "~/lib/constants";

describe("retention window math", () => {
  it("cutoffFor subtracts the window in days", () => {
    const now = new Date("2026-07-12T00:00:00.000Z").getTime();
    expect(cutoffFor(90, now).toISOString()).toBe(
      new Date(now - 90 * DAY_MS).toISOString(),
    );
  });

  it("monthKeyUTC buckets by UTC year-month", () => {
    expect(monthKeyUTC(new Date("2026-07-12T23:59:59.000Z"))).toBe("2026-07");
    expect(monthKeyUTC(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
    expect(monthKeyUTC(new Date("2025-12-31T23:00:00.000Z"))).toBe("2025-12");
  });
});

describe("aggregateAiCalls", () => {
  const row = (over: Partial<AiCallRow>): AiCallRow => ({
    id: "c1",
    accountId: "acc_1",
    model: "claude-sonnet-5",
    promptTokens: 1000,
    completionTokens: 500,
    createdAt: new Date("2026-04-10T00:00:00.000Z"),
    ...over,
  });

  it("sums tokens within one (account, model, month) bucket", () => {
    const out = aggregateAiCalls([
      row({ id: "a", promptTokens: 1000, completionTokens: 500 }),
      row({ id: "b", promptTokens: 2000, completionTokens: 250 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      accountKey: "acc_1",
      model: "claude-sonnet-5",
      month: "2026-04",
      promptTokens: 3000,
      completionTokens: 750,
    });
  });

  it("splits by month, model, and account; null account collapses to empty key", () => {
    const out = aggregateAiCalls([
      row({ id: "a", createdAt: new Date("2026-04-10T00:00:00.000Z") }),
      row({ id: "b", createdAt: new Date("2026-05-10T00:00:00.000Z") }),
      row({ id: "c", model: "claude-haiku-4-5-20251001" }),
      row({ id: "d", accountId: null }),
    ]);
    expect(out).toHaveLength(4);
    expect(out.some((g) => g.accountKey === "")).toBe(true);
  });

  it("summed-token cost equals the per-bucket cost (linearity holds)", () => {
    const [g] = aggregateAiCalls([
      row({ id: "a", promptTokens: 1_000_000, completionTokens: 0 }),
      row({ id: "b", promptTokens: 1_000_000, completionTokens: 0 }),
    ]);
    // 2,000,000 Sonnet input tokens at 300 cents/1M = 600 cents.
    expect(computeAiCallCostCents(g.model, g.promptTokens, g.completionTokens)).toBe(600);
  });
});
