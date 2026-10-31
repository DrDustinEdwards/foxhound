import { describe, expect, it, vi } from "vitest";

import { cronAlerts, cronRunHistory, emailDeadLetters } from "~/db/schema";
import {
  buildFailureAlertEmail,
  claimAlertSlot,
  findStaleCrons,
  runCronHealthCheck,
  SCHEDULE_PERIOD_MS,
  sendAlert,
  utcDay,
} from "~/lib/cron/alerts.server";
import { CRON_JOBS } from "~/lib/cron/registry";
import { recordDeadLetters } from "~/lib/email/dead-letters.server";
import { buildEmailSendRow } from "~/lib/email/dispatch";
import type { EmailJob } from "~/lib/email/types";

import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

// RULING 313: the observability batch. Ruling 311 measured three holes and this
// closes them.
//
//   A. A failing cron recorded status "failed" to cron_run_history and notified
//      NOBODY. billing-monthly has never executed once in any environment, and
//      nothing would have said so.
//   B. foxhound-email-dlq had ZERO consumers (measured against the account), so
//      a dunning email that exhausted its retries was discarded with no trace.
//   C. Nothing joined email_sends to cron_run_history, so "which run sent this"
//      meant correlating timestamps.
//
// The sends are faked at the EMAIL binding, never at the alert module, so what
// runs here is the real dedupe, the real fail-open, and the real row writes.

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** An alert's words, before rendering: its first sentence and its detail lines. */
function words(built: { alert: { intro: string; details: string[] } }): string {
  return [built.alert.intro, ...built.alert.details].join("\n");
}

function envWith(send: () => Promise<{ id: string }>) {
  return { EMAIL: { send } } as unknown as Env;
}
const okEnv = () => envWith(async () => ({ id: "msg_1" }));
const brokenEnv = () =>
  envWith(async () => {
    throw new Error("email binding exploded");
  });

describe("313 A: the alert dedupes in the DATABASE, not in application logic", () => {
  it("claims the slot once per cron per kind per day", async () => {
    const { db } = createInMemoryDb();
    expect(await claimAlertSlot(db, "billing-monthly", "failure", NOW)).toBe(true);
    // Second claim, same day, same kind: refused by the unique index.
    expect(await claimAlertSlot(db, "billing-monthly", "failure", NOW)).toBe(false);
    // A DIFFERENT kind is a different problem and alerts on its own.
    expect(await claimAlertSlot(db, "billing-monthly", "stale", NOW)).toBe(true);
    // And tomorrow is a new day.
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(await claimAlertSlot(db, "billing-monthly", "failure", tomorrow)).toBe(true);
  });

  it("THE DEDUPE IS THE INDEX: a second send is refused without emailing", async () => {
    const { db } = createInMemoryDb();
    const sent: string[] = [];
    const env = envWith(async () => {
      sent.push("x");
      return { id: "m" };
    });
    const message = { subject: "s", bodyHtml: "<p>b</p>" };

    const first = await sendAlert(env, db, "recovery-tick", "failure", message, NOW);
    const second = await sendAlert(env, db, "recovery-tick", "failure", message, NOW);

    expect(first).toEqual({ sent: true });
    expect(second).toEqual({ sent: false, reason: "deduped" });
    expect(sent).toHaveLength(1); // the second never reached the binding
  });

  it("FAIL-OPEN: a broken email binding does not throw, it reports", async () => {
    // The load-bearing property. An observability tool that can fail the money
    // job it observes is worse than no observability.
    const { db } = createInMemoryDb();
    const outcome = await sendAlert(
      brokenEnv(),
      db,
      "recovery-tick",
      "failure",
      { subject: "s", bodyHtml: "<p>b</p>" },
      NOW,
    );
    expect(outcome).toEqual({
      sent: false,
      reason: "send_failed",
      error: "email binding exploded",
    });
  });

  it("the failure email names the cron, the run, the error and the last success", () => {
    const built = buildFailureAlertEmail(
      {
        cronName: "billing-monthly",
        runId: "run_abc",
        error: "D1 timeout",
        lastSuccessAt: new Date("2026-07-01T04:00:00.000Z"),
      },
      NOW,
    );
    expect(built.subject).toContain("billing-monthly");
    expect(words(built)).toContain("run_abc");
    expect(words(built)).toContain("D1 timeout");
    expect(words(built)).toContain("2026-07-01T04:00:00.000Z");
  });

  it("says 'never' rather than nothing when a cron has no successful run", () => {
    const built = buildFailureAlertEmail(
      { cronName: "billing-monthly", runId: null, error: null, lastSuccessAt: null },
      NOW,
    );
    expect(words(built)).toMatch(/never/i);
  });

  it("utcDay is the day-granularity key", () => {
    expect(utcDay(new Date("2026-08-16T23:59:59.000Z"))).toBe("2026-08-16");
    expect(utcDay(new Date("2026-08-17T00:00:01.000Z"))).toBe("2026-08-17");
  });
});

describe("313 A: the never-executed detector", () => {
  const jobs = [
    { name: "recovery-tick", schedule: "*/5 * * * *" },
    { name: "billing-monthly", schedule: "0 4 1 * *" },
    { name: "demo-reset", schedule: "0 3 * * *" },
  ];

  it("flags a cron overdue against its own schedule, and not one within tolerance", async () => {
    // cron_runs, as runJobs writes it: each job's last success in epoch ms.
    const { sqlite } = createInMemoryDb();
    const ok = (name: string, every: number, agoMs: number) =>
      sqlite
        .prepare("INSERT INTO cron_runs (name, every_minutes, first_started_at, last_ok_at) VALUES (?, ?, ?, ?)")
        .run(name, every, NOW.getTime() - agoMs, NOW.getTime() - agoMs);
    // 30 minutes for a 5-minute job: well past two periods.
    ok("recovery-tick", 5, 30 * 60_000);
    ok("billing-monthly", 44_640, 60_000);
    // 25 hours for a daily job: inside two periods, so NOT stale.
    ok("demo-reset", 1440, 25 * 60 * 60_000);
    const stale = await findStaleCrons(d1Over(sqlite), jobs, NOW);
    expect(stale.map((s) => s.cronName)).toEqual(["recovery-tick"]);
    expect(stale[0].reason).toBe("overdue");
  });

  it("EVERY SCHEDULE THE REGISTRY USES HAS A PERIOD (376 item 15)", () => {
    // THE DEFECT THIS CLOSES. CRON_SCHEDULE_WEEKLY was never added to the period
    // table, so weekly-digest reported `unknown_schedule` every single day from
    // the moment session 55 introduced the repo's first new cron expression. The
    // table's own comment predicted this exact failure and did not prevent it,
    // because "it announces itself" means a line in a daily report nobody reads.
    //
    // DERIVED FROM THE REGISTRY, never a hand list: the set under test is
    // whatever CRON_JOBS actually schedules, so a schedule added next year is
    // covered on the day it is added rather than on the day somebody remembers.
    const scheduled = [...new Set(CRON_JOBS.map((j) => j.schedule))];

    // THE READER, MUTATED. A derivation that returns nothing
    // makes "every schedule has a period" vacuously true, and this guard would
    // pass over an empty registry while every job on earth went unwatched.
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.length).toBe(new Set(CRON_JOBS.map((j) => j.schedule)).size);
    // And the registry genuinely holds the job whose schedule was missing, so
    // this is not passing because weekly-digest quietly left the registry.
    expect(CRON_JOBS.map((j) => j.name)).toContain("weekly-digest");

    for (const schedule of scheduled) {
      expect(SCHEDULE_PERIOD_MS[schedule], `no period for schedule ${schedule}`).toBeGreaterThan(0);
    }
  });

  it("the health check alerts on findings and reports what it did", async () => {
    const { db, sqlite } = createInMemoryDb();
    const result = await runCronHealthCheck(
      { ...okEnv(), DB: d1Over(sqlite) } as unknown as Env,
      db,
      [{ name: "billing-monthly", schedule: "0 4 1 * *" }],
      NOW,
    );
    expect(result.rowsProcessed).toBe(1);
    expect(result.message).toContain("never_run");
    const alerts = await db.select().from(cronAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("stale");
  });
});

describe("313 B: the dead-letter trace", () => {
  const job: EmailJob = {
    accountId: "acct_1",
    recoveryStepId: "step_1",
    to: "customer@example.com",
    subject: "Your payment failed",
    bodyHtml: "<p>x</p>",
    template: "recovery_dunning",
    unsubscribeToken: "t",
    physicalAddress: "addr",
    idempotencyKey: "step_1:0",
  };

  it("writes a row for an exhausted send, so the discard leaves a trace", async () => {
    const { db } = createInMemoryDb();
    const result = await recordDeadLetters(
      okEnv(),
      db,
      [{ id: "qm_1", attempts: 3, body: job }],
      NOW,
    );
    expect(result.written).toBe(1);
    expect(result.failed).toBe(0);

    const rows = await db.select().from(emailDeadLetters);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: "acct_1",
      recoveryStepId: "step_1",
      queueMessageId: "qm_1",
      template: "recovery_dunning",
      attempts: 3,
    });
  });

  it("stores a HASH, never the recipient address", async () => {
    const { db } = createInMemoryDb();
    await recordDeadLetters(okEnv(), db, [{ id: "qm_1", attempts: 3, body: job }], NOW);
    const rows = await db.select().from(emailDeadLetters);
    expect(rows[0].recipientHash).toBeTruthy();
    expect(rows[0].recipientHash).not.toBe(job.to);
    expect(JSON.stringify(rows)).not.toContain("customer@example.com");
  });

  it("ONE BAD MESSAGE DOES NOT DISCARD THE BATCH, which is the whole point", async () => {
    // Reproducing the silent discard inside the fix would be the worst outcome.
    const { db } = createInMemoryDb();
    const result = await recordDeadLetters(
      okEnv(),
      db,
      [
        { id: "qm_1", attempts: 3, body: job },
        { id: "qm_2", attempts: 3, body: null },
        { id: "qm_3", attempts: 3, body: job },
      ],
      NOW,
    );
    expect(result.written).toBe(2);
    expect(result.failed).toBe(1);
  });

  it("raises ONE alert for the batch, deduped with the cron alerts", async () => {
    const { db } = createInMemoryDb();
    await recordDeadLetters(okEnv(), db, [{ id: "a", attempts: 3, body: job }], NOW);
    await recordDeadLetters(okEnv(), db, [{ id: "b", attempts: 3, body: job }], NOW);

    const alerts = await db.select().from(cronAlerts);
    expect(alerts).toHaveLength(1); // a burst is one problem, not N
    expect(alerts[0].kind).toBe("dead_letter");
    expect(await db.select().from(emailDeadLetters)).toHaveLength(2); // both rows still written
  });
});

describe("313 C: send-to-run attribution", () => {
  const base: EmailJob = {
    accountId: "acct_1",
    recoveryStepId: "step_1",
    to: "c@example.com",
    subject: "s",
    bodyHtml: "<p>b</p>",
    template: "recovery_dunning",
    unsubscribeToken: "t",
    physicalAddress: "a",
    idempotencyKey: "step_1:0",
  };

  it("stamps the run id onto the send row", () => {
    const { db } = createInMemoryDb();
    const { sql, params } = (
      buildEmailSendRow(db, {
        job: { ...base, cronRunId: "run_xyz" },
        status: "sent",
        providerMessageId: "pm",
        error: null,
        recipientHash: "h",
        queueMessageId: null,
        now: NOW,
      }) as unknown as { toSQL(): { sql: string; params: unknown[] } }
    ).toSQL();
    expect(sql).toMatch(/cron_run_id/);
    expect(params).toContain("run_xyz");
  });
});

// The WIRING, driven through the real runCronJob. Everything above tests the
// alert module; this proves the runner actually calls it, which is the part that
// would silently rot if only the module were covered.
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
const { runCronJob } = await import("~/lib/cron/run");

function lockEnv(send: () => Promise<{ id: string }>) {
  const stub = { acquire: async () => true, release: async () => {} };
  return {
    EMAIL: { send },
    BETTER_AUTH_URL: "https://foxhound.example.com",
    CRON_LOCK: { get: () => stub, idFromName: (n: string) => n },
    DB: {},
  } as unknown as Env;
}

describe("313 A: runCronJob actually alerts", () => {

  it("a SECOND failure the same day is deduped, and the run still records", async () => {
    harness.db = createInMemoryDb().db;
    const env = lockEnv(async () => ({ id: "m" }));
    const boom = async () => {
      throw new Error("boom");
    };

    await runCronJob(env, "billing-monthly", boom);
    const second = await runCronJob(env, "billing-monthly", boom);

    expect(second.alert).toEqual({ sent: false, reason: "deduped" });
    const db = harness.db as ReturnType<typeof createInMemoryDb>["db"];
    expect(await db.select().from(cronRunHistory)).toHaveLength(2); // both runs recorded
    expect(await db.select().from(cronAlerts)).toHaveLength(1); // one alert
  });
});
