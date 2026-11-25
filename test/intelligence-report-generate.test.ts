import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, aiCalls, customerContext, intelligenceReports, mrrSnapshots } from "~/db";
import { INTELLIGENCE_REPORT_HOURLY_LIMIT } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { makeRateLimiterNamespace } from "./helpers/rate-limiter";

// Intelligence is free, so the report is a template and the button never calls a
// model: ~/lib/ai/client throws here if it is reached.

const createMock = vi.fn();
vi.mock("~/lib/ai/client", () => {
  const refuse = () => {
    createMock();
    throw new Error("Intelligence must not call a model");
  };
  return { askModel: refuse, askStructured: refuse };
});

const { generateMonthlyReport } = await import("~/lib/intelligence/report-generate.server");

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

// The hourly limit lives on the RATE_LIMITER Durable Object, which serializes
// every check for one key, so parallel clicks cannot all slip past a count.
// The fake namespace runs site-runtime's counting on SQLite, with a clock the
// test moves.
let clock = NOW;
const fakeRateLimiter = () => makeRateLimiterNamespace(() => clock);
let limiter = fakeRateLimiter();
let ENV = { RATE_LIMITER: limiter } as unknown as Env;

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

beforeEach(() => {
  createMock.mockReset();
  clock = NOW;
  limiter = fakeRateLimiter();
  ENV = { RATE_LIMITER: limiter } as unknown as Env;
});

describe("generateMonthlyReport", () => {
  it("refuses a month that is not YYYY-MM, and any month but the current one", async () => {
    const db = await seed();
    for (const [month, error] of [
      ["2026-13", "invalid_month"],
      ["oct", "invalid_month"],
      ["2026-09", "not_current_month"],
    ]) {
      expect(await generateMonthlyReport(ENV, db, "acc_1", month!, NOW)).toEqual({
        ok: false,
        error,
      });
    }
  });

  it("writes this month's report from the engine's facts, with no model call", async () => {
    const db = await seed();
    const result = await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW);
    const narrative =
      "Total MRR is $5,000.00. Since the day before: $200.00 new, $50.00 expansion, $10.00 contraction, " +
      "$30.00 churned, a net gain of $210.00. $99.00 of MRR is at risk across 1 customer. " +
      "The lowest health score is Low Co at 20/100.";
    expect(result).toEqual({ ok: true, month: "2026-10", narrative });

    const reports = await db
      .select()
      .from(intelligenceReports)
      .where(eq(intelligenceReports.accountId, "acc_1"));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reportMonth.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(reports[0]!.narrative).toBe(narrative);
    const [cc] = await db.select().from(customerContext).where(eq(customerContext.id, "cc_1"));
    expect(cc!.aiAssessment).toBe("Health score 20/100 on $99.00 of MRR. 2 refunds on record.");
    expect(await db.select().from(aiCalls)).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("allows the hourly limit of generations per account and refuses the next", async () => {
    const db = await seed();
    for (let i = 0; i < INTELLIGENCE_REPORT_HOURLY_LIMIT; i++) {
      expect(await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW)).toMatchObject({
        ok: true,
      });
    }
    expect(await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limiter.names.every((k) => k === "intelligence-report:acc_1")).toBe(true);
  });

  it("starts a fresh hour once the hour has passed", async () => {
    const db = await seed();
    for (let i = 0; i <= INTELLIGENCE_REPORT_HOURLY_LIMIT; i++)
      await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW);
    clock = NOW + 60 * 60 * 1000;
    expect(await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW)).toMatchObject({
      ok: true,
    });
  });

  it("keeps each account's hour to itself", async () => {
    const db = await seed();
    await db
      .insert(accounts)
      .values({ id: "acc_2", name: "Beta", currency: "usd", createdAt: new Date(NOW) });
    for (let i = 0; i <= INTELLIGENCE_REPORT_HOURLY_LIMIT; i++)
      await generateMonthlyReport(ENV, db, "acc_1", "2026-10", NOW);
    expect(await generateMonthlyReport(ENV, db, "acc_2", "2026-10", NOW)).toMatchObject({
      ok: true,
    });
  });
});
