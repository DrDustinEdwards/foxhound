import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, aiCalls, customerContext, intelligenceReports, mrrSnapshots } from "~/db";
import { INTELLIGENCE_REPORT_HOURLY_LIMIT } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { makeRateLimiterNamespace } from "./helpers/rate-limiter";

// J67: Recova's "Generate report" / "Regenerate report" button on the
// Intelligence dashboard (MonthlyNarrative.tsx at blob 791e2f5f, posting to
// app/api/intelligence/generate-report/route.ts at blob 45732914), hooked into
// Foxhound's own narrative engine (app/lib/intelligence/narrative.ts), never
// Recova's prompt or its facts.
//
// What is Recova's: the month it is asked for, its five-per-hour limit per
// account, and its error words. What is Foxhound's: the facts (the latest MRR
// snapshot and the stored health scores, the same ones the nightly run
// narrates), the one writer of intelligence_reports, and a regenerate that
// regenerates (Recova returned the cached report unchanged under a button that
// said "Regenerate", which was not true).
//
// The narrative needs Anthropic credit (launch blocker 2). A missing key and an
// unfunded key each come back as their own named error for the page to show,
// never as a silent nothing.

const createMock = vi.fn();
vi.mock("~/lib/ai/client", () => ({
  createAnthropicClient: () => ({ messages: { create: createMock } }),
}));

const { generateMonthlyReport, classifyNarrativeError } = await import(
  "~/lib/intelligence/report-generate.server"
);

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

// The hourly limit lives on the RATE_LIMITER Durable Object, which serializes
// every check for one key, so parallel clicks cannot all slip past a count.
// The fake namespace runs site-runtime's counting on SQLite, with a clock the
// test moves.
let clock = NOW;
const fakeRateLimiter = () => makeRateLimiterNamespace(() => clock);
let limiter = fakeRateLimiter();
let ENV = { ANTHROPIC_API_KEY: "sk-test", RATE_LIMITER: limiter } as unknown as Env;

async function seed() {
  const { db } = createInMemoryDb();
  const now = new Date(NOW);
  await db.insert(accounts).values({ id: "acc_1", name: "Acme", currency: "usd", createdAt: now });
  await db.insert(mrrSnapshots).values({
    id: "mrr_1",
    accountId: "acc_1",
    snapshotDate: new Date(Date.UTC(2026, 9, 1, 4)),
    totalMrrCents: 500_000,
    newMrrCents: 20_000,
    expansionMrrCents: 5_000,
    contractionMrrCents: 1_000,
    churnMrrCents: 3_000,
    reactivationMrrCents: 0,
    activeCustomersCount: 40,
    newCustomersCount: 2,
    churnedCustomersCount: 1,
    perPlanBreakdown: {},
    perCohortBreakdown: [],
    perChannelBreakdown: {},
    currency: "usd",
    createdAt: now,
  });
  await db.insert(customerContext).values({
    id: "cc_1",
    accountId: "acc_1",
    stripeCustomerId: "cus_low",
    customerName: "Low Co",
    mrrContributionCents: 9_900,
    healthScore: 20,
    healthFactors: [{ key: "refunds", points: -10, detail: "2 refunds on record" }],
    createdAt: now,
    updatedAt: now,
  } as never);
  return db;
}

function modelReply(narrative: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          narrative,
          customerAssessments: [{ stripeCustomerId: "cus_low", assessment: "Two refunds pulled it down." }],
        }),
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

beforeEach(() => {
  createMock.mockReset();
  clock = NOW;
  limiter = fakeRateLimiter();
  ENV = { ANTHROPIC_API_KEY: "sk-test", RATE_LIMITER: limiter } as unknown as Env;
});

describe("generateMonthlyReport: Recova's button on Foxhound's engine", () => {
  it("refuses a month that is not YYYY-MM, as Recova does", async () => {
    const db = await seed();
    expect(await generateMonthlyReport(ENV, db, "acc_1", "2026-13", NOW)).toEqual({ ok: false, error: "invalid_month" });
    expect(await generateMonthlyReport(ENV, db, "acc_1", "oct", NOW)).toEqual({ ok: false, error: "invalid_month" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("generates only the current month, because the engine's facts are today's", async () => {
    const db = await seed();
    expect(await generateMonthlyReport(ENV, db, "acc_1", "2026-09", NOW)).toEqual({
      ok: false,
      error: "not_current_month",
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("writes this month's report through the engine and returns it", async () => {
    const db = await seed();
    createMock.mockResolvedValue(modelReply("MRR held at $5,000.00."));
    const result = await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW);
    expect(result).toEqual({ ok: true, month: "2026-10", narrative: "MRR held at $5,000.00." });

    // The prompt carries the engine's own facts: the snapshot's MRR and the
    // stored at-risk customer with its stored factor.
    const prompt = JSON.stringify(createMock.mock.calls[0]![0]);
    expect(prompt).toContain("Total MRR: $5,000.00");
    expect(prompt).toContain("Low Co");
    expect(prompt).toContain("2 refunds on record");

    const reports = await db.select().from(intelligenceReports).where(eq(intelligenceReports.accountId, "acc_1"));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reportMonth.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(reports[0]!.narrative).toBe("MRR held at $5,000.00.");
    const calls = await db.select().from(aiCalls).where(eq(aiCalls.accountId, "acc_1"));
    expect(calls.map((c) => c.source)).toEqual(["intelligence_narrative"]);
    const [cc] = await db.select().from(customerContext).where(eq(customerContext.id, "cc_1"));
    expect(cc!.aiAssessment).toBe("Two refunds pulled it down.");
  });

  it("allows Recova's five generations an hour per account and refuses the sixth", async () => {
    const db = await seed();
    expect(INTELLIGENCE_REPORT_HOURLY_LIMIT).toBe(5);
    createMock.mockResolvedValue(modelReply("Fine."));
    for (let i = 0; i < INTELLIGENCE_REPORT_HOURLY_LIMIT; i++) {
      expect(await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW)).toMatchObject({ ok: true });
    }
    expect(await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW)).toEqual({ ok: false, error: "rate_limited" });
    expect(createMock).toHaveBeenCalledTimes(INTELLIGENCE_REPORT_HOURLY_LIMIT);
    expect(limiter.names.every((k) => k === "intelligence-report:acc_1")).toBe(true);
  });

  it("starts a fresh hour once the hour has passed", async () => {
    const db = await seed();
    createMock.mockResolvedValue(modelReply("Fine."));
    for (let i = 0; i <= INTELLIGENCE_REPORT_HOURLY_LIMIT; i++) await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW);
    clock = NOW + 60 * 60 * 1000;
    expect(await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW)).toMatchObject({ ok: true });
  });

  it("keeps each account's hour to itself", async () => {
    const db = await seed();
    await db.insert(accounts).values({ id: "acc_2", name: "Beta", currency: "usd", createdAt: new Date(NOW) });
    createMock.mockResolvedValue(modelReply("Fine."));
    for (let i = 0; i <= INTELLIGENCE_REPORT_HOURLY_LIMIT; i++) await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW);
    expect(await generateMonthlyReport(ENV, db, "acc_2", "2026-10", NOW)).toMatchObject({ ok: true });
  });

  // A paid call is never made unmetered: if the limiter itself errors, the
  // button refuses with its own sentence rather than calling the model.
  it("fails closed when the limiter errors: no model call, and its own error", async () => {
    const db = await seed();
    const cause = new Error("Durable Object reset");
    const broken = { idFromName: (n: string) => n, get: () => ({ hit: () => Promise.reject(cause) }) };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await generateMonthlyReport(
      { ANTHROPIC_API_KEY: "sk-test", RATE_LIMITER: broken } as unknown as Env,
      db,
      "acc_1",
      "2026-10",
      NOW,
    );
    expect(result).toEqual({ ok: false, error: "limiter_unavailable" });
    expect(createMock).not.toHaveBeenCalled();
    expect(log.mock.calls.some((call) => String(call[0]).includes(cause.message))).toBe(true);
    expect(await db.select().from(intelligenceReports)).toHaveLength(0);
    log.mockRestore();
  });

  it("fails visibly with no AI key, and writes nothing", async () => {
    const db = await seed();
    const result = await generateMonthlyReport({ RATE_LIMITER: limiter } as unknown as Env, db, "acc_1", "2026-10", NOW);
    expect(result).toEqual({ ok: false, error: "ai_not_configured" });
    expect(await db.select().from(intelligenceReports)).toHaveLength(0);
  });
});

describe("classifyNarrativeError", () => {
  it("tells a missing key, an unfunded key and anything else apart", () => {
    expect(classifyNarrativeError(new Error("ANTHROPIC_API_KEY is not set"))).toBe("ai_not_configured");
    expect(
      classifyNarrativeError(Object.assign(new Error("Your credit balance is too low"), { status: 400 })),
    ).toBe("ai_no_credit");
    expect(classifyNarrativeError(Object.assign(new Error("bad request"), { status: 400 }))).toBe("generation_failed");
    expect(classifyNarrativeError("boom")).toBe("generation_failed");
  });
});
