import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

// The public estimator refuses out-of-range input before any database write.
const recorded = vi.hoisted(() => ({ runs: 0 }));
vi.mock("@dustinedwards/site-runtime/turnstile", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyTurnstile: async () => ({ ok: true }),
}));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDb: () => ({}),
}));
vi.mock("~/lib/estimator/estimate.server", () => ({
  estimateLeakage: async () => ({ estimatedLeakageCents: 1 }),
  recordEstimatorRun: async () => {
    recorded.runs += 1;
  },
}));

const { action } = await import("~/routes/audit");

async function post(fields: Record<string, string>) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: { TURNSTILE_SECRET_KEY: "test-secret" } as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  const body = new FormData();
  for (const [k, v] of Object.entries({ "cf-turnstile-response": "tok", ...fields }))
    body.append(k, v);
  const res = (await (action as (args: unknown) => Promise<unknown>)({
    request: new Request("https://foxhoundapp.test/audit", { method: "POST", body }),
    context,
    params: {},
  })) as { init: { status?: number } | null; data: { ok: boolean } };
  return { status: res.init?.status ?? 200, ok: res.data.ok };
}

describe("estimator bounds", () => {
  it("refuses out-of-range input and records nothing", async () => {
    for (const fields of [
      { mrr: "1e308", customerCount: "10", currency: "usd" },
      { mrr: "5000", customerCount: "2.5", currency: "usd" },
      { mrr: "5000", customerCount: "1e12", currency: "usd" },
      { mrr: "5000", customerCount: "10", currency: "x".repeat(10_000) },
    ]) {
      expect(await post(fields), JSON.stringify(fields).slice(0, 60)).toEqual({
        status: 400,
        ok: false,
      });
    }
    expect(recorded.runs).toBe(0);
    expect(await post({ mrr: "5000", customerCount: "10", currency: "eur" })).toEqual({
      status: 200,
      ok: true,
    });
  });
});
