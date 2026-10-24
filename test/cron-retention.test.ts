import { describe, expect, it } from "vitest";

import { aggregateAiCalls, type AiCallRow } from "~/lib/cron/retention";

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
});
