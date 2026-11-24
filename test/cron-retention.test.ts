import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  aiCalls,
  aiCallsMonthly,
  customerContext,
  emailSends,
  engagementEvents,
  healthScoreHistory,
  webhookEvents,
} from "~/db/schema";
import type { AiCallRow } from "~/lib/cron/retention";
import { D1_MAX_BOUND_PARAMS } from "@dustinedwards/site-runtime/d1";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Retention sweeps must stay under D1's bound-parameter ceiling. retention-health-score failed
// every day for 29 days because `deleteOlderThan` bound one parameter per aged row (417 against D1's
// 100). The tests run on better-sqlite3, whose limit is orders of magnitude higher, so a behavioral
// sweep of 417 rows passes with the bug in place. The assertion is therefore on the SQL production
// would send, captured off the driver. It does not exercise D1 itself; the live proof is a
// production run in cron_run_log.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const retention = await import("~/lib/cron/retention");

/** The exact row count that broke production. Above the ceiling by 4.17x. */
const N = 417;
/** Older than every retention window, the longest of which is 365 days. */
const AGED = new Date("2020-01-01T00:00:00.000Z");
/** Inside every window, so these rows must SURVIVE the sweep. */
const FRESH = new Date();
const FRESH_COUNT = 3;

type TestDb = ReturnType<typeof createInMemoryDb>["db"];

/** Insert in chunks so the SEEDING itself never trips a parameter limit and
 *  masks what is being measured. */
async function insertMany(
  db: TestDb,
  table: Parameters<TestDb["insert"]>[0],
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 40) {
    await db.insert(table).values(rows.slice(i, i + 40) as never);
  }
}

function rowsOf(n: number, build: (i: number, when: Date) => Record<string, unknown>, when: Date) {
  return Array.from({ length: n }, (_, i) => build(i, when));
}

/** Capture every SQL string the driver is asked to prepare, so the assertion is
 *  against what production would SEND. Installed after seeding. */
function captureStatements(sqlite: Database.Database): string[] {
  const captured: string[] = [];
  const original = sqlite.prepare.bind(sqlite);
  (sqlite as unknown as { prepare: (s: string) => unknown }).prepare = (source: string) => {
    captured.push(source);
    return original(source);
  };
  return captured;
}

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;
const deletesIn = (captured: string[]) => captured.filter((s) => /^\s*delete/i.test(s));

interface SweeperCase {
  fn: (env: Env) => Promise<{ rowsProcessed: number }>;
  seed: (db: TestDb, n: number, when: Date) => Promise<void>;
  /** True where an id list is semantically required, so the delete is BATCHED
   *  rather than converted to a predicate. */
  batched?: boolean;
}

const SWEEPERS: Record<string, SweeperCase> = {
  sweepEngagementEvents: {
    fn: retention.sweepEngagementEvents,
    seed: (db, n, when) =>
      insertMany(
        db,
        engagementEvents,
        rowsOf(
          n,
          (i) => ({
            id: `ee_${when.getTime()}_${i}`,
            eventType: "click",
            idempotencyKey: `k_${when.getTime()}_${i}`,
            occurredAt: when,
            createdAt: when,
          }),
          when,
        ),
      ),
  },
  sweepEmailSends: {
    fn: retention.sweepEmailSends,
    seed: (db, n, when) =>
      insertMany(
        db,
        emailSends,
        rowsOf(
          n,
          (i) => ({ id: `es_${when.getTime()}_${i}`, status: "sent", createdAt: when }),
          when,
        ),
      ),
  },
  sweepWebhookEvents: {
    fn: retention.sweepWebhookEvents,
    seed: (db, n, when) =>
      insertMany(
        db,
        webhookEvents,
        rowsOf(
          n,
          (i) => ({
            id: `we_${when.getTime()}_${i}`,
            stripeEventId: `evt_${when.getTime()}_${i}`,
            eventType: "invoice.payment_failed",
            receivedAt: when,
            payload: {},
          }),
          when,
        ),
      ),
  },
  sweepHealthScoreHistory: {
    fn: retention.sweepHealthScoreHistory,
    // Foreign keys are enforced by the harness, so the account and one customer_context parent
    // are created first. Idempotent, because the seed runs twice per case.
    seed: async (db, n, when) => {
      await db
        .insert(accounts)
        .values({ id: "acct_ret", name: "Acme", createdAt: when })
        .onConflictDoNothing();
      await db
        .insert(customerContext)
        .values({
          id: "cc_ret",
          accountId: "acct_ret",
          stripeCustomerId: "cus_ret",
          createdAt: when,
          updatedAt: when,
        })
        .onConflictDoNothing();
      await insertMany(
        db,
        healthScoreHistory,
        rowsOf(
          n,
          (i) => ({
            id: `hsh_${when.getTime()}_${i}`,
            accountId: "acct_ret",
            customerContextId: "cc_ret",
            stripeCustomerId: `cus_${i}`,
            recordedAt: when,
            healthScore: 50,
            healthFactors: {},
            scoreSource: "deterministic",
          }),
          when,
        ),
      );
    },
  },
  sweepAiCalls: {
    fn: retention.sweepAiCalls,
    batched: true,
    seed: (db, n, when) =>
      insertMany(
        db,
        aiCalls,
        rowsOf(
          n,
          (i) => ({
            id: `ai_${when.getTime()}_${i}`,
            source: "narrative",
            model: "claude-haiku-4-5",
            promptTokens: 10,
            completionTokens: 5,
            costCents: 1,
            currency: "usd",
            createdAt: when,
          }),
          when,
        ),
      ),
  },
};

describe("retention sweeps", () => {
  it("every exported sweep* is exercised here, and nothing here is a phantom", () => {
    const exported = Object.keys(retention)
      .filter((k) => k.startsWith("sweep"))
      .sort();
    expect(Object.keys(SWEEPERS).sort()).toEqual(exported);
  });

  for (const [name, sweeper] of Object.entries(SWEEPERS)) {
    it(`${name} sweeps ${N} aged rows within D1's ${D1_MAX_BOUND_PARAMS} bound parameters`, async () => {
      const { sqlite, db } = createInMemoryDb();
      harness.db = db;
      await sweeper.seed(db, N, AGED);
      await sweeper.seed(db, FRESH_COUNT, FRESH);

      const captured = captureStatements(sqlite);
      const result = await sweeper.fn({} as Env);

      // It really did the work, so the ceiling assertion is not passing on a no-op sweep.
      expect(result.rowsProcessed).toBe(N);
      expect(deletesIn(captured).length).toBeGreaterThan(0);
      expect(Math.max(...captured.map(placeholders))).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });
  }

  it("sweepAiCalls aggregates into monthly buckets and removes every aged row", async () => {
    // Aggregate and delete are one batch, so a partial delete can never leave rows counted but
    // undeleted.
    const { db } = createInMemoryDb();
    harness.db = db;
    await SWEEPERS.sweepAiCalls.seed(db, N, AGED);

    await retention.sweepAiCalls({} as Env);

    expect(await db.select().from(aiCalls)).toHaveLength(0);
    const monthly = await db.select().from(aiCallsMonthly);
    expect(monthly).toHaveLength(1);
    expect(monthly[0].promptTokens).toBe(N * 10);
    expect(monthly[0].completionTokens).toBe(N * 5);
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

  it("splits by month, model, and account; null account collapses to empty key", () => {
    const out = retention.aggregateAiCalls([
      row({ id: "a", createdAt: new Date("2026-04-10T00:00:00.000Z") }),
      row({ id: "b", createdAt: new Date("2026-05-10T00:00:00.000Z") }),
      row({ id: "c", model: "claude-haiku-4-5-20251001" }),
      row({ id: "d", accountId: null }),
    ]);
    expect(out).toHaveLength(4);
    expect(out.some((g) => g.accountKey === "")).toBe(true);
  });
});
