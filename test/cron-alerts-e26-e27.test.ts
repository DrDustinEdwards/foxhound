import { afterEach, describe, expect, it, vi } from "vitest";

import { cronAlerts, cronRunHistory } from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";

// ROWS E26 AND E27: the cron failure and cron stale
// alerts, checked against Recova's lib/cron-monitor.ts (blob 2891dd9b,
// notifyCronFailure and notifyCronStale), app/api/cron/check-cron-health/
// route.ts (blob 5341fc8a) and app/api/cron/process-recovery-billing/route.ts
// (blob 77ef8e45). Recova's words, Foxhound's name, on Capsomer's `alert`
// template. The sends are faked at the EMAIL binding only, so the real dedupe,
// render and send seam run.

const NOW = new Date("2026-08-16T12:00:00.000Z");
const BASE = "https://foxhound.example.com";

interface Sent {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

const harness = vi.hoisted(() => ({ db: null as unknown, sent: [] as unknown[] }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// The one seam the billing trigger test breaks: an account whose billable read
// throws, which is how a per-account billing failure reaches the run's catch.
const billable = vi.hoisted(() => ({ throwFor: null as string | null }));
vi.mock("~/db/billable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/db/billable")>();
  return {
    ...actual,
    getBillableRecoveries: async (...args: Parameters<typeof actual.getBillableRecoveries>) => {
      if (billable.throwFor && args[1] === billable.throwFor) throw new Error("D1 read failed");
      return actual.getBillableRecoveries(...args);
    },
  };
});

const {
  alertCronFailure,
  buildFailureAlertEmail,
  describeAge,
  runCronHealthCheck,
} = await import("~/lib/cron/alerts.server");
const { CRON_JOBS } = await import("~/lib/cron/registry");
const { runCronJob } = await import("~/lib/cron/run");
const constants = await import("~/lib/constants");
const schema = await import("~/db/schema");

function env(): Env {
  harness.sent = [];
  return {
    BETTER_AUTH_URL: BASE,
    EMAIL: {
      send: async (m: Sent) => {
        harness.sent.push(m);
        return { id: "msg_1" };
      },
    },
    CRON_LOCK: { get: () => ({ acquire: async () => "tok", release: async () => {} }), idFromName: (n: string) => n },
    DB: {},
  } as unknown as Env;
}
function sent(): Sent[] {
  return harness.sent as Sent[];
}
function only(): Sent {
  expect(sent()).toHaveLength(1);
  return sent()[0];
}
/** Each line in BOTH parts, the text part as written and the HTML part escaped. */
function expectBothParts(m: Sent, lines: string[]): void {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  for (const line of lines) {
    expect(m.text, `text part: ${line}`).toContain(line);
    expect(m.html, `html part: ${line}`).toContain(esc(line));
  }
}

afterEach(() => {
  vi.useRealTimers();
  billable.throwFor = null;
});

// ---- E26 ------------------------------------------------------------------------

describe("E26: the cron failure alert says what Recova's notifyCronFailure says", () => {
  const input = {
    cronName: "billing-monthly",
    runId: "run_abc",
    error: "D1 timeout",
    stack: "Error: D1 timeout\n    at bill (app/lib/billing/run.ts:12:3)\n    at run (app/lib/cron/run.ts:9:1)",
    lastSuccessAt: new Date("2026-07-01T04:00:00.000Z"),
  };

  it("the stack is cut at Recova's 500 characters", () => {
    const stack = `Error: long\n${"x".repeat(480)}${"TAIL-PAST-500".repeat(10)}`;
    const built = buildFailureAlertEmail({ ...input, stack }, NOW);
    const all = JSON.stringify(built);
    expect(all).toContain("x".repeat(480));
    expect(all).not.toContain("TAIL-PAST-500TAIL");
  });

  it("no stack, no stack lines (Recova's `error?.stack ?` guard)", async () => {
    const db = createInMemoryDb().db;
    harness.db = db;
    await alertCronFailure(env(), db, { ...input, stack: null }, NOW);
    expect(only().text).not.toContain("Stack (first 500 chars):");
  });

  it("a refused send returns its named outcome and never throws", async () => {
    const db = createInMemoryDb().db;
    harness.db = db;
    const broken = { ...env(), EMAIL: { send: async () => { throw new Error("binding exploded"); } } } as unknown as Env;
    expect(await alertCronFailure(broken, db, input, NOW)).toEqual({
      sent: false,
      reason: "send_failed",
      error: "binding exploded",
    });
    const noBinding = { ...env(), EMAIL: undefined } as unknown as Env;
    const second = await alertCronFailure(noBinding, createInMemoryDb().db, input, NOW);
    expect(second).toMatchObject({ sent: false, reason: "send_failed" });
  });
});

describe("E26 trigger: every cron's catch, with the error's stack", () => {
  it("a failing run sends the alert with Recova's stack excerpt", async () => {
    harness.db = createInMemoryDb().db;
    const e = env();
    const outcome = await runCronJob(e, "recovery-tick", async () => {
      throw new Error("boom");
    });
    expect(outcome.alert).toEqual({ sent: true });
    const m = only();
    expect(m.subject).toBe("[Foxhound Ops] Cron failure: recovery-tick");
    expectBothParts(m, ["Message: boom", "Stack (first 500 chars):", "Error: boom"]);
    expect(m.text).toContain(`Run id: ${outcome.runId}`);
  });
});

describe("E26 trigger: the billing run alerts when any account fails to invoice", () => {
  async function seedAccounts(ids: string[]) {
    const { db } = createInMemoryDb();
    harness.db = db;
    for (const id of ids) {
      await db.insert(schema.accounts).values({
        id,
        name: `Co ${id}`,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        platformStripeCustomerId: `cus_${id}`,
        billingExempt: false,
      });
    }
    return db;
  }
  const billingHandler = () => CRON_JOBS.find((j) => j.name === "billing-monthly")!.handler;

  it("one alert naming the count, the month and the accounts; the run still succeeds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T04:00:00.000Z"));
    await seedAccounts(["acc_ok", "acc_bad"]);
    billable.throwFor = "acc_bad";
    const e = env();

    const result = await billingHandler()(e, { runId: "run_bill" });

    expect(result.rowsProcessed).toBe(0);
    const m = only();
    expect(m.subject).toBe("[Foxhound Ops] Cron failure: billing-monthly");
    expectBothParts(m, [
      "The billing-monthly cron failed.",
      "Message: 1 account(s) failed to invoice for July 2026: acc_bad.",
      "Run id: run_bill",
    ]);
  });

  it("no failed account, no alert", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T04:00:00.000Z"));
    await seedAccounts(["acc_ok"]);
    await billingHandler()(env(), { runId: "run_bill" });
    expect(sent()).toHaveLength(0);
  });
});

// ---- E27 ------------------------------------------------------------------------

describe("E27: the cron stale alert says what Recova's notifyCronStale says", () => {

  it("Recova's describeAge, its units and its floor", () => {
    expect(describeAge(59_000)).toBe("59 seconds ago");
    expect(describeAge(61_000)).toBe("1 minutes ago");
    expect(describeAge(90 * 60_000)).toBe("1 hours ago");
    expect(describeAge(49 * 60 * 60_000)).toBe("2 days ago");
  });

  it("TRIGGER: no SUCCESSFUL run within the interval, as Recova's watcher reads last_succeeded_at", async () => {
    // A cron that keeps running and failing is stale to Recova: its watcher
    // reads last_succeeded_at, not the last run of any status.
    const db = createInMemoryDb().db;
    harness.db = db;
    const recentFail = new Date(NOW.getTime() - 60_000);
    await db.insert(cronRunHistory).values({
      id: "f1",
      cronName: "d1-backup",
      finishedAt: recentFail,
      status: "failed",
      createdAt: recentFail,
    });
    const oldSuccess = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    await db.insert(cronRunHistory).values({
      id: "s1",
      cronName: "d1-backup",
      finishedAt: oldSuccess,
      status: "success",
      createdAt: oldSuccess,
    });
    await runCronHealthCheck(env(), db, [{ name: "d1-backup", schedule: constants.CRON_SCHEDULE_DAILY }], NOW);
    const m = only();
    expectBothParts(m, [`Last succeeded: ${oldSuccess.toISOString()}`, "Age: last succeeded 3 days ago"]);
  });

  it("an unmapped schedule is reported in the run, never emailed (Recova alerts only on its schedule list)", async () => {
    const db = createInMemoryDb().db;
    harness.db = db;
    const result = await runCronHealthCheck(env(), db, [{ name: "mystery", schedule: "0 0 */3 * *" }], NOW);
    expect(result.message).toContain("mystery(unknown_schedule)");
    expect(sent()).toHaveLength(0);
    expect(await db.select().from(cronAlerts)).toHaveLength(0);
  });
});
