import { describe, expect, it, vi } from "vitest";

import { emailDeadLetters } from "~/db/schema";
import { runCronHealthCheck, SCHEDULE_PERIOD_MS } from "~/lib/cron/alerts.server";
import { CRON_JOBS } from "~/lib/cron/registry";
import { recordDeadLetters } from "~/lib/email/dead-letters.server";
import { buildEmailSendRow } from "~/lib/email/dispatch";
import type { EmailJob } from "~/lib/email/types";

import { loggedRuns, runJob } from "./helpers/cron";
import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

// Cron failures, dead letters and send attribution. The sends are faked at the EMAIL binding,
// never at the alert module, so what runs is the real dedupe, the real fail-open and the real
// row writes.

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** A fresh database with an env whose DB binding and EMAIL binding run over it. */
function setup(send: () => Promise<{ id: string }> = async () => ({ id: "msg_1" })) {
  const { sqlite, db } = createInMemoryDb();
  const env = { EMAIL: { send }, DB: d1Over(sqlite) } as unknown as Env;
  const alerts = () => sqlite.prepare("SELECT * FROM alerts_sent").all() as Array<{ kind: string }>;
  return { db, env, alerts };
}

describe("the never-executed detector", () => {
  it("every schedule the registry uses has a period", () => {
    // A schedule missing from the period table reported `unknown_schedule` daily for weekly-digest
    // and nobody read it. Derived from the registry so a new schedule is covered the day it lands.
    const scheduled = [...new Set(CRON_JOBS.map((j) => j.schedule))];
    expect(CRON_JOBS.map((j) => j.name)).toContain("weekly-digest");
    for (const schedule of scheduled) {
      expect(SCHEDULE_PERIOD_MS[schedule], `no period for schedule ${schedule}`).toBeGreaterThan(0);
    }
  });

  it("the health check alerts on findings and reports what it did", async () => {
    const { db, env, alerts } = setup();
    const result = await runCronHealthCheck(
      env,
      db,
      [{ name: "billing-monthly", schedule: "0 4 1 * *" }],
      NOW,
    );
    expect(result.rowsProcessed).toBe(1);
    expect(result.message).toContain("never ran");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].kind).toBe("stale");
  });
});

describe("the dead-letter trace", () => {
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

  it("writes a row for an exhausted send, storing a hash and never the recipient address", async () => {
    const { db, env } = setup();
    const result = await recordDeadLetters(env, db, [{ id: "qm_1", attempts: 3, body: job }], NOW);
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
    expect(rows[0].recipientHash).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain("customer@example.com");
  });

  it("one bad message does not discard the batch", async () => {
    const { db, env } = setup();
    const result = await recordDeadLetters(
      env,
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

  it("raises one alert for the batch, deduped with the cron alerts", async () => {
    const { db, env, alerts } = setup();
    await recordDeadLetters(env, db, [{ id: "a", attempts: 3, body: job }], NOW);
    await recordDeadLetters(env, db, [{ id: "b", attempts: 3, body: job }], NOW);

    expect(alerts()).toHaveLength(1); // a burst is one problem, not N
    expect(alerts()[0].kind).toBe("dead_letter");
    expect(await db.select().from(emailDeadLetters)).toHaveLength(2); // both rows still written
  });
});

describe("send-to-run attribution", () => {
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

// Driven through the real runner: this proves the runner actually calls the alert module.
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

function lockEnv(send: () => Promise<{ id: string }>, sqlite: Parameters<typeof d1Over>[0]) {
  const stub = { acquire: async () => true, release: async () => {} };
  return {
    EMAIL: { send },
    BETTER_AUTH_URL: "https://foxhound.example.com",
    CRON_LOCK: { get: () => stub, idFromName: (n: string) => n },
    DB: d1Over(sqlite),
  } as unknown as Env;
}

describe("the runner actually alerts", () => {
  it("a second failure the same day is deduped, and the run still records", async () => {
    const { sqlite, db: fresh } = createInMemoryDb();
    harness.db = fresh;
    const env = lockEnv(async () => ({ id: "m" }), sqlite);
    const boom = async () => {
      throw new Error("boom");
    };

    await runJob(env, "billing-monthly", boom);
    await runJob(env, "billing-monthly", boom);

    expect(loggedRuns(sqlite, "billing-monthly").map((r) => r.outcome)).toEqual([
      "failed",
      "failed",
    ]); // both runs recorded
    expect(sqlite.prepare("SELECT * FROM alerts_sent").all()).toHaveLength(1); // one alert
  });
});
