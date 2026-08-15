import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import * as schema from "~/db/schema";
import {
  aiModelCost,
  buildAiCallRow,
  computeAiCallCostCents,
  normalizeModelId,
} from "~/lib/ai/cost";
import { AI_MODEL_IDS } from "~/lib/constants";

const db = drizzle({} as never, { schema });
const sqlOf = (item: unknown) => (item as { toSQL(): { sql: string; params: unknown[] } }).toSQL();

describe("R-49: cost map covers every model id", () => {
  it("every AI_MODEL_IDS entry resolves to a cost (no drift, no gaps)", () => {
    for (const id of AI_MODEL_IDS) {
      expect(() => aiModelCost(id)).not.toThrow();
    }
  });

  it("normalizes a dated alias to the canonical base id", () => {
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("throws loudly for an uncovered model", () => {
    expect(() => aiModelCost("claude-unknown-9")).toThrow(/no ai_calls cost entry/);
  });
});

describe("cost math", () => {
  it("computes cents from per-1M rates", () => {
    // Sonnet 5: 300 cents/1M in, 1500 cents/1M out.
    // 1,000,000 in + 1,000,000 out = 300 + 1500 = 1800 cents.
    expect(computeAiCallCostCents("claude-sonnet-5", 1_000_000, 1_000_000)).toBe(1_800);
    // Haiku (dated alias): 100 in + 500 out per 1M -> 600 cents at 1M each.
    expect(computeAiCallCostCents("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBe(600);
  });

  it("rounds a partial cent UP, never down (CHUNKS item 17 no-undercount policy)", () => {
    // 2000 in + 500 out of Sonnet: (0.002*300)+(0.0005*1500) = 0.6 + 0.75 = 1.35.
    // Math.round gave 1 and undercounted; ceil gives 2.
    expect(computeAiCallCostCents("claude-sonnet-5", 2_000, 500)).toBe(2);
  });

  it("never records zero for a call that cost something", () => {
    // 100 prompt tokens of Sonnet = 0.03 cents. Math.round sent this to 0, so a
    // workload of thousands of small calls tracked as free. This is the case the
    // policy exists for: the per-call error is one cent, the aggregate error was
    // the entire spend.
    expect(computeAiCallCostCents("claude-sonnet-5", 100, 0)).toBe(1);
  });
});

describe("buildAiCallRow", () => {
  it("inserts an ai_calls row with the computed cost", () => {
    const { sql, params } = sqlOf(
      buildAiCallRow(db, {
        accountId: "acc_1",
        source: "recovery_email",
        model: "claude-sonnet-5",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        relatedId: "step_1",
        createdAt: new Date("2026-07-12T00:00:00.000Z"),
      }),
    );
    expect(sql).toMatch(/insert into .*ai_calls/i);
    expect(params).toContain(1_800); // computed cost cents
    expect(params).toContain("recovery_email");
  });
});
