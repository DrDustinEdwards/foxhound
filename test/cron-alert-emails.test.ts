import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

// The cron failure and stale alerts; only the EMAIL binding is faked.

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

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  sent: [] as unknown[],
}));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// An account whose billable read throws, as a per-account billing failure does.
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

const { alertCronFailure, runCronHealthCheck } = await import("~/lib/cron/alerts.server");
const { CRON_JOBS } = await import("~/lib/cron/registry");
const { runJob, loggedRuns } = await import("./helpers/cron");
const { cronRunId } = await import("~/lib/admin/crons");
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
    CRON_LOCK: {
      get: () => ({ acquire: async () => "tok", release: async () => {} }),
      idFromName: (n: string) => n,
    },
    DB: d1Over(harness.sqlite as Parameters<typeof d1Over>[0]),
  } as unknown as Env;
}
/** A fresh migrated database, the one getDb() and env().DB both reach. */
function freshDb() {
  const { sqlite, db } = createInMemoryDb();
  harness.db = db;
  harness.sqlite = sqlite;
  return db;
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
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  for (const line of lines) {
    expect(m.text, `text part: ${line}`).toContain(line);
    expect(m.html, `html part: ${line}`).toContain(esc(line));
  }
}

afterEach(() => {
  vi.useRealTimers();
  billable.throwFor = null;
});

describe("the cron failure alert", () => {
  const input = {
    cronName: "billing-monthly",
    runId: "run_abc",
    error: "D1 timeout",
    stack:
      "Error: D1 timeout\n    at bill (app/lib/billing/run.ts:12:3)\n    at run (app/lib/cron/run.ts:9:1)",
    lastSuccessAt: new Date("2026-07-01T04:00:00.000Z"),
  };

  it("a refused send returns its named outcome and never throws", async () => {
    const db = freshDb();
    harness.db = db;
    const broken = {
      ...env(),
      EMAIL: {
        send: async () => {
          throw new Error("binding exploded");
        },
      },
    } as unknown as Env;
    expect(await alertCronFailure(broken, db, input, NOW)).toEqual({
      sent: false,
      reason: "send_failed",
      error: "binding exploded",
    });
    const noBinding = { ...env(), EMAIL: undefined } as unknown as Env;
    const second = await alertCronFailure(noBinding, freshDb(), input, NOW);
    expect(second).toMatchObject({ sent: false, reason: "send_failed" });
  });
});

describe("every cron's catch sends the alert", () => {
  it("a failing run sends the alert with the stack excerpt", async () => {
    harness.db = freshDb();
    const e = env();
    await runJob(e, "recovery-tick", async () => {
      throw new Error("boom");
    });
    const [run] = loggedRuns(harness.sqlite as Parameters<typeof loggedRuns>[0], "recovery-tick");
    const m = only();
    expect(m.subject).toBe("[Foxhound Ops] Cron failure: recovery-tick");
    expectBothParts(m, ["Message: boom", "Stack (first 500 chars):", "Error: boom"]);
    expect(m.text).toContain(`Run id: ${cronRunId("recovery-tick", run!.started_at)}`);
  });
});

describe("the billing run alerts when any account fails to invoice", () => {
  async function seedAccounts(ids: string[]) {
    const db = freshDb();
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

describe("the cron stale alert", () => {
  it("fires when there was no successful run within the interval", async () => {
    freshDb();
    const oldSuccess = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    (harness.sqlite as Parameters<typeof d1Over>[0])
      .prepare(
        "INSERT INTO cron_runs (name, every_minutes, first_started_at, last_started_at, last_ok_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("d1-backup", 1440, oldSuccess.getTime(), oldSuccess.getTime(), oldSuccess.getTime());
    await runCronHealthCheck(
      env(),
      harness.db as ReturnType<typeof freshDb>,
      [{ name: "d1-backup", schedule: constants.CRON_SCHEDULE_DAILY }],
      NOW,
    );
    const m = only();
    expectBothParts(m, [
      `Last succeeded: ${oldSuccess.toISOString()}`,
      "Age: last succeeded 3 days ago",
    ]);
  });
});
