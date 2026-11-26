import { describe, expect, it, vi } from "vitest";

import { runCronHealthCheck, SCHEDULE_PERIOD_MS } from "~/lib/cron/alerts.server";
import { CRON_JOBS } from "~/lib/cron/registry";
import { executeEmailStep } from "~/lib/engine/execute-step";

import { loggedRuns, runJob } from "./helpers/cron";
import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

// Cron failure alerts; sends are faked at the EMAIL binding, not the alert module.

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

describe("a recovery email that fails for good", () => {
  const step = (stepId: string) => ({
    stepId,
    accountId: "acct_1",
    failedPaymentId: "fp_1",
    stepType: "email_day1",
    attemptCount: 4,
    declineCategory: "expired",
    liveSendsEnabled: true,
    customerEmail: "jane@example.com",
    customerName: "Jane",
    amountCents: 4900,
    currency: "usd",
    merchantName: "Teamflow",
    senderName: "Teamflow",
    voiceDescription: null,
    cached: { customBody: null, cachedSubject: null, cachedBodyHtml: null },
  });

  it("alerts the support inbox once a day, after the last retry", async () => {
    const sent: { subject: string }[] = [];
    const { env, alerts } = setup(async (m?: unknown) => {
      sent.push(m as { subject: string });
      return { id: "msg_1" };
    });
    Object.assign(env, {
      ENCRYPTION_KEY: "ab".repeat(32),
      BETTER_AUTH_URL: "https://foxhoundapp.test",
      PHYSICAL_ADDRESS: "1 Test Way",
    });
    const deps = {
      generate: async () => {
        throw new Error("no model");
      },
      send: async () => ({
        status: "failed" as const,
        providerMessageId: null,
        error: "E_DAILY_LIMIT_EXCEEDED",
        retryable: true,
      }),
      persistPatch: async () => {},
    };

    const first = await executeEmailStep(env, step("step_1"), deps);
    await executeEmailStep(env, step("step_2"), deps);

    expect(first.result).toBe("email_failed");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].kind).toBe("email_failed");
    expect(sent.map((m) => m.subject)).toEqual(["Foxhound recovery email failed for good"]);
  });
});
