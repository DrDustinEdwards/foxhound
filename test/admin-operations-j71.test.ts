
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { CRON_JOBS } from "~/lib/cron/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J71 (job_77e09916862e): /admin/operations on the family admin pattern
// (Capsomer's parts, Dustin's Q9 of 2026-10-14) and his 2026-10-11 review.
// Recova's page (app/admin/operations/OperationsClient.tsx, blob 419a51ac) is
// the inventory: the global pause (which is /admin/brake here and is not
// repeated), a queue-depth card ("Payments in active recovery queue"), a
// cron-lock health table (Idle, Running, Stale), a run-now panel (ruling 406
// binding 5 keeps it out) and a Vercel redeploy hook (no Cloudflare
// counterpart). Foxhound's own four panels stay: database size, table growth,
// migrations and settings.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// Looked up so a missing module or export fails the assertion that names it,
// not the whole file (RULES.md 6.5).
const route: Record<string, unknown> = await import("~/routes/admin/operations").catch(() => ({}));
const lib: Record<string, unknown> = await import("~/lib/admin/operations.server").catch(() => ({}));
const lockState: Record<string, unknown> = await import("~/lib/cron/lock-state").catch(() => ({}));

const NOW = Date.UTC(2026, 9, 15, 18, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

type Sqlite = ReturnType<typeof createInMemoryDb>["sqlite"];

// ------------------------------------------------------------ the lock's view

describe("the cron lock's read-only view", () => {
  it("leaves the holder's token out, since the token is the fence", () => {
    const view = lockState.cronLockView as (s: unknown) => Record<string, unknown>;
    expect(typeof view).toBe("function");
    const v = view({ lock: { heldUntil: NOW + MIN, token: "secret-token" }, legacyHeldUntil: null });
    expect(v).toEqual({ heldUntil: NOW + MIN, legacyHeldUntil: null });
    expect(JSON.stringify(v)).not.toContain("secret-token");
  });

  it("says idle with no record, running while the lease holds, and not released after it ran out", () => {
    const health = lockState.cronLockHealth as (v: unknown, now: number) => Record<string, unknown>;
    expect(typeof health).toBe("function");
    expect(health({ heldUntil: null, legacyHeldUntil: null }, NOW)).toEqual({ state: "idle", heldUntil: null });
    expect(health({ heldUntil: NOW + 5 * MIN, legacyHeldUntil: null }, NOW)).toEqual({
      state: "running",
      heldUntil: NOW + 5 * MIN,
    });
    // A lease that ran out and was never released: the run stopped without its
    // release, or is still going past its lease. The next run takes it anyway.
    expect(health({ heldUntil: NOW - 5 * MIN, legacyHeldUntil: null }, NOW)).toEqual({
      state: "not-released",
      heldUntil: NOW - 5 * MIN,
    });
    // Exactly now is expired, the boundary decideAcquire uses.
    expect(health({ heldUntil: NOW, legacyHeldUntil: null }, NOW).state).toBe("not-released");
  });

  it("reads the pre-fence key too, the later of the two winning", () => {
    const health = lockState.cronLockHealth as (v: unknown, now: number) => Record<string, unknown>;
    expect(health({ heldUntil: null, legacyHeldUntil: NOW + MIN }, NOW)).toEqual({ state: "running", heldUntil: NOW + MIN });
    expect(health({ heldUntil: NOW - MIN, legacyHeldUntil: NOW + 2 * MIN }, NOW).state).toBe("running");
  });
});

// --------------------------------------------------------- reading the locks

function lockNamespace(views: Record<string, unknown>, failing: string[] = []) {
  const asked: string[] = [];
  return {
    asked,
    ns: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        peek: async () => {
          asked.push(id.name);
          if (failing.includes(id.name)) throw new Error("Durable Object unavailable");
          return views[id.name] ?? { heldUntil: null, legacyHeldUntil: null };
        },
      }),
    },
  };
}

describe("readCronLocks", () => {
  it("reads every registered cron's lock, in the registry's order", async () => {
    const read = lib.readCronLocks as (env: unknown, now: number) => Promise<Array<Record<string, unknown>>>;
    expect(typeof read).toBe("function");
    const { ns, asked } = lockNamespace({
      "recovery-tick": { heldUntil: NOW + 3 * MIN, legacyHeldUntil: null },
      "weekly-digest": { heldUntil: NOW - HOUR, legacyHeldUntil: null },
    });
    const locks = await read({ CRON_LOCK: ns }, NOW);
    expect(locks.map((l) => l.name)).toEqual(CRON_JOBS.map((j) => j.name));
    expect(asked.sort()).toEqual(CRON_JOBS.map((j) => j.name).sort());
    expect(locks.find((l) => l.name === "recovery-tick")).toEqual({
      name: "recovery-tick",
      state: "running",
      heldUntil: new Date(NOW + 3 * MIN),
    });
    expect(locks.find((l) => l.name === "weekly-digest")).toMatchObject({ state: "not-released" });
    expect(locks.find((l) => l.name === "d1-backup")).toEqual({ name: "d1-backup", state: "idle", heldUntil: null });
  });
});

// Review of #97: one hung Durable Object must not stall the whole loader.
describe("readCronLocks with a lock that never answers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on it after CRON_LOCK_PEEK_TIMEOUT_MS, shows the rest, and leaves no timer running", async () => {
    const constants: Record<string, unknown> = await import("~/lib/constants");
    const timeout = constants.CRON_LOCK_PEEK_TIMEOUT_MS as number;
    expect(typeof timeout).toBe("number");
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(5000);

    vi.useFakeTimers();
    const read = lib.readCronLocks as (env: unknown, now: number) => Promise<Array<Record<string, unknown>>>;
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        peek: () =>
          id.name === "d1-backup"
            ? new Promise(() => {})
            : Promise.resolve(
                id.name === "recovery-tick"
                  ? { heldUntil: NOW + MIN, legacyHeldUntil: null }
                  : { heldUntil: null, legacyHeldUntil: null },
              ),
      }),
    };
    let settled = false;
    const pending = read({ CRON_LOCK: ns }, NOW).then((locks) => {
      settled = true;
      return locks;
    });
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const locks = await pending;
    expect(locks.find((l) => l.name === "d1-backup")).toEqual({ name: "d1-backup", state: "unreadable", heldUntil: null });
    expect(locks.find((l) => l.name === "recovery-tick")?.state).toBe("running");
    expect(locks.filter((l) => l.state === "unreadable")).toHaveLength(1);
    // Every timer is cleared once its read is settled, the answered ones included.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears each timer when its lock answers in time", async () => {
    vi.useFakeTimers();
    const read = lib.readCronLocks as (env: unknown, now: number) => Promise<Array<Record<string, unknown>>>;
    const { ns } = lockNamespace({});
    await read({ CRON_LOCK: ns }, NOW);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ------------------------------------------------------ the recovery queue

function seedQueue(sqlite: Sqlite) {
  const account = (id: string, paused = 0, cancelled: number | null = null) =>
    sqlite
      .prepare("insert into accounts (id, name, processing_paused, cancelled_at) values (?, ?, ?, ?)")
      .run(id, id, paused, cancelled);
  account("acc_live");
  account("acc_paused", 1);
  account("demo_acc", 0);
  const payment = (id: string, accountId: string, status: string) =>
    sqlite
      .prepare(
        "insert into failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) values (?, ?, ?, ?, 'c', 'x@example.com', 4200, 'usd', 'soft', ?, 0)",
      )
      .run(id, accountId, `e_${id}`, `i_${id}`, status);
  payment("fp_1", "acc_live", "active");
  payment("fp_2", "acc_live", "active");
  payment("fp_3", "acc_live", "recovered");
  payment("fp_4", "acc_paused", "active");
  payment("fp_demo", "demo_acc", "active");
  const step = (id: string, fp: string, accountId: string, scheduledAt: number, over: { nextRetryAt?: number; executedAt?: number } = {}) =>
    sqlite
      .prepare(
        "insert into recovery_steps (id, failed_payment_id, step_type, scheduled_at, account_id, next_retry_at, executed_at) values (?, ?, 'email', ?, ?, ?, ?)",
      )
      .run(id, fp, scheduledAt, accountId, over.nextRetryAt ?? null, over.executedAt ?? null);
  step("s_due_old", "fp_1", "acc_live", NOW - 40 * MIN);
  step("s_due_new", "fp_2", "acc_live", NOW - 2 * MIN);
  // Rescheduled by a send backoff to later: not due, though scheduled long ago.
  step("s_backoff", "fp_2", "acc_live", NOW - 3 * HOUR, { nextRetryAt: NOW + 10 * MIN });
  // Rescheduled to a time that has come: due, and the oldest of all.
  step("s_retry_due", "fp_1", "acc_live", NOW - 5 * HOUR, { nextRetryAt: NOW - 50 * MIN });
  step("s_future", "fp_1", "acc_live", NOW + HOUR);
  step("s_done", "fp_1", "acc_live", NOW - HOUR, { executedAt: NOW - HOUR });
  step("s_recovered", "fp_3", "acc_live", NOW - HOUR);
  step("s_paused", "fp_4", "acc_paused", NOW - HOUR);
  step("s_demo", "fp_demo", "demo_acc", NOW - HOUR);
}

describe("getRecoveryQueueDepth", () => {
  it("counts payments in recovery as the Overview does, and the steps the tick would run now", async () => {
    const depth = lib.getRecoveryQueueDepth as (db: unknown, now: number) => Promise<Record<string, unknown>>;
    expect(typeof depth).toBe("function");
    const { db, sqlite } = createInMemoryDb();
    seedQueue(sqlite);
    const result = await depth(db, NOW);
    // fp_1, fp_2 and the paused account's fp_4; never the demo account's.
    expect(result.activePayments).toBe(3);
    // s_due_old, s_due_new and s_retry_due: the paused, demo, recovered, done,
    // future and backed-off steps are not the tick's to run.
    expect(result.dueSteps).toBe(3);
    expect(result.oldestDueAt).toEqual(new Date(NOW - 50 * MIN));
  });

  it("is empty on an empty database", async () => {
    const depth = lib.getRecoveryQueueDepth as (db: unknown, now: number) => Promise<Record<string, unknown>>;
    const { db } = createInMemoryDb();
    expect(await depth(db, NOW)).toEqual({ activePayments: 0, dueSteps: 0, oldestDueAt: null });
  });
});

// ---------------------------------------------------------------- the loader

describe("the loader", () => {
  beforeEach(() => {
    const made = createInMemoryDb();
    harness.db = made.db;
    seedQueue(made.sqlite);
  });

  it("reads the queue and the locks with Foxhound's own engine", async () => {
    expect(typeof route.loader).toBe("function");
    const { ns } = lockNamespace({ "recovery-tick": { heldUntil: Date.now() + 5 * MIN, legacyHeldUntil: null } });
    const env = {
      CRON_LOCK: ns,
      DB: {
        prepare: (sql: string) => ({
          run: async () => ({ meta: { size_after: 4096 } }),
          all: async () => ({ results: sql.includes("d1_migrations") ? [] : [] }),
        }),
      },
    };
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: env as unknown as Env, ctx: {} as ExecutionContext, nonce: "" });
    const loader = route.loader as (args: unknown) => Promise<Record<string, unknown>>;
    const data = await loader({ request: new Request("https://foxhoundapp.com/admin/operations"), context, params: {} });
    expect(data.queue).toMatchObject({ activePayments: 3 });
    const locks = data.locks as Array<Record<string, unknown>>;
    expect(locks).toHaveLength(CRON_JOBS.length);
    expect(locks.find((l) => l.name === "recovery-tick")?.state).toBe("running");
    expect(data.sizeBytes).toBe(4096);
  });
});





