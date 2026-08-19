import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  aiCalls,
  aiCallsMonthly,
  cronRunHistory,
  customerContext,
  emailSends,
  engagementEvents,
  healthScoreHistory,
  page404Daily,
  socialLeads,
  webhookEvents,
} from "~/db/schema";
import { D1_MAX_BOUND_PARAMS, DELETE_ID_BATCH_SIZE } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 317: retention-health-score failed EVERY DAY for 29 days
// (2026-07-22 to 2026-08-19, 29 runs, rows_processed 0) because
// `deleteOlderThan` built one bound parameter per aged row. Measured from
// production: 417 placeholders against D1's DOCUMENTED ceiling of 100
// (developers.cloudflare.com/d1/platform/limits/, "Maximum bound parameters per
// query"). health_score_history held 1,242 rows, 417 of them past the 90 day
// window, which matches the placeholder count exactly.
//
// WHY THE PARAMETER COUNT IS THE ASSERTION, AND A BEHAVIOURAL TEST IS NOT.
// These tests run on better-sqlite3, whose SQLITE_MAX_VARIABLE_NUMBER is orders
// of magnitude above D1's 100. So a test that merely sweeps 417 rows and checks
// they are gone PASSES WITH THE BUG STILL IN PLACE. That is the harness
// disagreeing with production, and it is the reason this bug shipped and then
// survived 29 days of daily failure. The guard therefore asserts the SQL that
// production would SEND, captured off the real driver, not the result it gets
// back here. The "HARNESS GAP" test at the bottom pins that difference, so
// nobody later "simplifies" this suite into a behavioural one.
//
// COVERAGE BOUND (246): this proves no retention statement exceeds the ceiling
// and that the sweeps still delete the right rows. It does NOT exercise D1
// itself; the live proof is a real production run recorded in cron_run_history,
// which is a separate step and cannot be done from here.

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
        rowsOf(n, (i) => ({
          id: `ee_${when.getTime()}_${i}`,
          eventType: "click",
          idempotencyKey: `k_${when.getTime()}_${i}`,
          occurredAt: when,
          createdAt: when,
        }), when),
      ),
  },
  sweepEmailSends: {
    fn: retention.sweepEmailSends,
    seed: (db, n, when) =>
      insertMany(
        db,
        emailSends,
        rowsOf(n, (i) => ({ id: `es_${when.getTime()}_${i}`, status: "sent", createdAt: when }), when),
      ),
  },
  sweepWebhookEvents: {
    fn: retention.sweepWebhookEvents,
    seed: (db, n, when) =>
      insertMany(
        db,
        webhookEvents,
        rowsOf(n, (i) => ({
          id: `we_${when.getTime()}_${i}`,
          stripeEventId: `evt_${when.getTime()}_${i}`,
          eventType: "invoice.payment_failed",
          receivedAt: when,
          payload: {},
        }), when),
      ),
  },
  sweepHealthScoreHistory: {
    fn: retention.sweepHealthScoreHistory,
    // Foreign keys ARE enforced by the harness (measured: the first draft of
    // this seed failed on "FOREIGN KEY constraint failed"), so the account and
    // one customer_context parent are created first. Idempotent, because the
    // seed runs twice per case (aged rows, then fresh ones).
    seed: async (db, n, when) => {
      await db
        .insert(accounts)
        .values({ id: "acct_317", name: "Acme", createdAt: when })
        .onConflictDoNothing();
      await db
        .insert(customerContext)
        .values({
          id: "cc_317",
          accountId: "acct_317",
          stripeCustomerId: "cus_317",
          createdAt: when,
          updatedAt: when,
        })
        .onConflictDoNothing();
      await insertMany(
        db,
        healthScoreHistory,
        rowsOf(n, (i) => ({
          id: `hsh_${when.getTime()}_${i}`,
          accountId: "acct_317",
          customerContextId: "cc_317",
          stripeCustomerId: `cus_${i}`,
          recordedAt: when,
          healthScore: 50,
          healthFactors: {},
          scoreSource: "deterministic",
        }), when),
      );
    },
  },
  sweepCronRunHistory: {
    fn: retention.sweepCronRunHistory,
    seed: (db, n, when) =>
      insertMany(
        db,
        cronRunHistory,
        rowsOf(n, (i) => ({
          id: `crh_${when.getTime()}_${i}`,
          cronName: "recovery-tick",
          startedAt: when,
          finishedAt: when,
          status: "success",
          rowsProcessed: 0,
          createdAt: when,
        }), when),
      ),
  },
  sweepPage404Daily: {
    fn: retention.sweepPage404Daily,
    seed: (db, n, when) =>
      insertMany(
        db,
        page404Daily,
        rowsOf(n, (i) => ({ id: `p4_${when.getTime()}_${i}`, day: when, path: `/x/${i}`, hitCount: 1 }), when),
      ),
  },
  sweepSocialLeads: {
    fn: retention.sweepSocialLeads,
    seed: (db, n, when) =>
      insertMany(
        db,
        socialLeads,
        rowsOf(n, (i) => ({
          id: `sl_${when.getTime()}_${i}`,
          platform: "reddit",
          postUrl: `https://example.test/${when.getTime()}/${i}`,
          intentScore: 1,
          status: "new",
          scoutRunAt: when,
          repliedAt: null,
          createdAt: when,
        }), when),
      ),
  },
  sweepAiCalls: {
    fn: retention.sweepAiCalls,
    batched: true,
    seed: (db, n, when) =>
      insertMany(
        db,
        aiCalls,
        rowsOf(n, (i) => ({
          id: `ai_${when.getTime()}_${i}`,
          source: "narrative",
          model: "claude-haiku-4-5",
          promptTokens: 10,
          completionTokens: 5,
          costCents: 1,
          currency: "usd",
          createdAt: when,
        }), when),
      ),
  },
};

// ============================================================================
// The list is DERIVED, so a new sweeper cannot be added without coverage
// ============================================================================

describe("317: the guard covers every sweeper, in both directions", () => {
  it("every exported sweep* is exercised here, and nothing here is a phantom", () => {
    // Derived from the module's own exports rather than restated, per the
    // standing rule: a hardcoded list mirroring source is the thing that rots.
    const exported = Object.keys(retention)
      .filter((k) => k.startsWith("sweep"))
      .sort();
    expect(Object.keys(SWEEPERS).sort()).toEqual(exported);
    expect(exported.length).toBe(8);
  });
});

// ============================================================================
// THE ASSERTION THAT WOULD HAVE CAUGHT IT: parameter count above the ceiling
// ============================================================================

describe(`317: no retention statement exceeds D1's ${D1_MAX_BOUND_PARAMS} bound parameters`, () => {
  for (const [name, sweeper] of Object.entries(SWEEPERS)) {
    it(`${name} sweeps ${N} aged rows within the ceiling`, async () => {
      const { sqlite, db } = createInMemoryDb();
      harness.db = db;
      await sweeper.seed(db, N, AGED);
      await sweeper.seed(db, FRESH_COUNT, FRESH);

      const captured = captureStatements(sqlite);
      const result = await sweeper.fn({} as Env);

      // It really did the work, so the ceiling assertion is not passing on a
      // sweep that quietly did nothing.
      expect(result.rowsProcessed).toBe(N);

      const deletes = deletesIn(captured);
      expect(deletes.length).toBeGreaterThan(0);
      const worst = Math.max(...captured.map(placeholders));
      expect(worst).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    });
  }
});

describe("317: the predicate sites carry NO id list at all", () => {
  const predicateSites = Object.entries(SWEEPERS).filter(([, s]) => !s.batched);

  for (const [name, sweeper] of predicateSites) {
    it(`${name}'s delete parameter count is CONSTANT, not merely under the ceiling`, async () => {
      // The stronger property: a batched fix would still scale with row count.
      // A predicate does not, so 417 rows and 150 rows must produce identical
      // parameter counts. This is what makes the fix immune to someone later
      // raising RETENTION_SWEEP_LIMIT.
      const counts: number[] = [];
      for (const n of [N, 150]) {
        const { sqlite, db } = createInMemoryDb();
        harness.db = db;
        await sweeper.seed(db, n, AGED);
        const captured = captureStatements(sqlite);
        await sweeper.fn({} as Env);
        counts.push(Math.max(...deletesIn(captured).map(placeholders)));
      }
      expect(counts[0]).toBe(counts[1]);
      expect(counts[0]).toBeLessThan(10);
    });
  }

  it("covers seven of the eight sweepers, the eighth being the batched one", () => {
    expect(predicateSites).toHaveLength(7);
  });
});

describe("317: sweepAiCalls keeps its id list, and batches it", () => {
  it("issues ceil(N / DELETE_ID_BATCH_SIZE) deletes, none above the batch size", async () => {
    const { sqlite, db } = createInMemoryDb();
    harness.db = db;
    await SWEEPERS.sweepAiCalls.seed(db, N, AGED);

    const captured = captureStatements(sqlite);
    const result = await retention.sweepAiCalls({} as Env);

    expect(result.rowsProcessed).toBe(N);
    const deletes = deletesIn(captured);
    expect(deletes).toHaveLength(Math.ceil(N / DELETE_ID_BATCH_SIZE));
    for (const stmt of deletes) expect(placeholders(stmt)).toBeLessThanOrEqual(DELETE_ID_BATCH_SIZE);
  });

  it("still aggregates into monthly buckets and removes every aged row", async () => {
    // The atomicity contract survives the chunking: aggregate and delete are one
    // batch, so a partial chunk set can never leave rows counted but undeleted.
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

// ============================================================================
// Correctness: the predicate must delete the aged rows and ONLY those
// ============================================================================

describe("317: the subquery predicate deletes the aged rows and spares fresh ones", () => {
  it("fresh rows survive a sweep of 417 aged ones", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await SWEEPERS.sweepHealthScoreHistory.seed(db, N, AGED);
    await SWEEPERS.sweepHealthScoreHistory.seed(db, FRESH_COUNT, FRESH);

    const before = await db.select().from(healthScoreHistory);
    expect(before).toHaveLength(N + FRESH_COUNT);

    const result = await retention.sweepHealthScoreHistory({} as Env);

    expect(result.rowsProcessed).toBe(N);
    const after = await db.select().from(healthScoreHistory);
    expect(after).toHaveLength(FRESH_COUNT);
    // Every survivor is a fresh one, so the predicate did not delete by luck.
    for (const row of after) expect(row.recordedAt.getTime()).toBeGreaterThan(AGED.getTime());
  });

  it("an empty table sweeps to zero and issues no delete at all", async () => {
    const { sqlite, db } = createInMemoryDb();
    harness.db = db;
    const captured = captureStatements(sqlite);
    const result = await retention.sweepHealthScoreHistory({} as Env);
    expect(result.rowsProcessed).toBe(0);
    expect(deletesIn(captured)).toHaveLength(0);
  });

  it("sweepSocialLeads still spares a lead that was replied to", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await SWEEPERS.sweepSocialLeads.seed(db, N, AGED);
    await db.insert(socialLeads).values({
      id: "sl_replied",
      platform: "reddit",
      postUrl: "https://example.test/replied",
      intentScore: 9,
      status: "replied",
      scoutRunAt: AGED,
      repliedAt: AGED,
      createdAt: AGED,
    });

    const result = await retention.sweepSocialLeads({} as Env);

    expect(result.rowsProcessed).toBe(N);
    const left = await db.select().from(socialLeads);
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe("sl_replied");
  });
});

// ============================================================================
// The ceiling itself, and why the harness cannot be the judge
// ============================================================================

describe("317: the ceiling, and the harness gap that hid it", () => {
  it("the documented D1 ceiling is pinned at 100 with a margin below it", () => {
    expect(D1_MAX_BOUND_PARAMS).toBe(100);
    expect(DELETE_ID_BATCH_SIZE).toBeLessThan(D1_MAX_BOUND_PARAMS);
  });

  it("HARNESS GAP: better-sqlite3 accepts far more parameters than D1, so behaviour alone proves nothing", () => {
    // This is the reason the bug shipped and then survived 29 days. If this ever
    // starts failing, the harness has gained D1's limit and a behavioural test
    // would finally be evidence; until then, only the parameter-count
    // assertions above are.
    const { sqlite } = createInMemoryDb();
    const ids = Array.from({ length: 417 }, (_, i) => `id_${i}`);
    const sql = `select 1 where 'x' in (${ids.map(() => "?").join(",")})`;
    expect(() => sqlite.prepare(sql).all(...ids)).not.toThrow();
    expect(ids.length).toBeGreaterThan(D1_MAX_BOUND_PARAMS);
  });

  it("chunkIds never emits a chunk above the batch size, and loses nothing", () => {
    const ids = Array.from({ length: N }, (_, i) => i);
    const chunks = retention.chunkIds(ids);
    expect(chunks.flat()).toEqual(ids);
    expect(chunks).toHaveLength(Math.ceil(N / DELETE_ID_BATCH_SIZE));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DELETE_ID_BATCH_SIZE);
  });

  it("chunkIds handles the boundaries: empty, exactly one chunk, one over", () => {
    expect(retention.chunkIds([])).toEqual([]);
    expect(retention.chunkIds(Array.from({ length: DELETE_ID_BATCH_SIZE }, (_, i) => i))).toHaveLength(1);
    expect(
      retention.chunkIds(Array.from({ length: DELETE_ID_BATCH_SIZE + 1 }, (_, i) => i)),
    ).toHaveLength(2);
  });
});
