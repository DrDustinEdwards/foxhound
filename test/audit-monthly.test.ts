import {
  AUDIT_QUEUE,
  CRON_JOBS,
  CRON_NAME,
  NOW,
  PERIOD,
  cronRunId,
  handleQueueBatch,
  seedAccount,
  setup,
} from "./helpers/audit-monthly";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { accounts, auditDigestRuns, auditRuns } from "~/db/schema";
import { loggedRuns, runJob } from "./helpers/cron";

// The queue wiring: the registered cron and the real consumer entry

interface Delivery {
  body: unknown;
  attempts?: number;
}

/** One batch into the real consumer entry. Returns what each message was told. */
async function deliver(e: Env, deliveries: Delivery[]) {
  const verdicts: ("ack" | "retry" | "none")[] = deliveries.map(() => "none");
  const messages = deliveries.map((d, i) => ({
    id: `msg_${i}`,
    timestamp: NOW,
    body: d.body,
    attempts: d.attempts ?? 1,
    ack: () => {
      verdicts[i] = "ack";
    },
    retry: () => {
      verdicts[i] = "retry";
    },
  }));
  await handleQueueBatch(
    {
      queue: AUDIT_QUEUE,
      messages,
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>,
    e,
  );
  return verdicts;
}

async function runCron(e: Env) {
  const job = CRON_JOBS.find((j) => j.name === CRON_NAME)!;
  return runJob(e, job.name, job.handler, job.schedule);
}

const bodyFor = (bodies: unknown[], accountId: string) =>
  bodies.find((b) => (b as { accountId?: string }).accountId === accountId);

const loggedText = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((args) =>
    args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "),
  );

describe("the cron enqueues one message per opted-in account and audits nothing itself", () => {
  it("only opted-in, processing-eligible accounts are queued, each with its month and run", async () => {
    const { db, sqlite, env, queue, stripeCalls, delivered } = setup();
    await seedAccount(db, "a_on");
    await seedAccount(db, "b_on");
    await seedAccount(db, "c_off", { auditAutoRun: false });
    await seedAccount(db, "d_null", { auditAutoRun: null });
    await seedAccount(db, "e_paused", { processingPaused: true });
    await seedAccount(db, "demo_teamflow");

    await runCron(env);

    const runs = loggedRuns(sqlite, CRON_NAME);
    expect(runs.map((r) => r.outcome)).toEqual(["ok"]);
    const queued = queue.bodies as { accountId: string }[];
    expect(queued.map((b) => b.accountId).sort()).toEqual(["a_on", "b_on"]);
    for (const body of queued) {
      expect(body).toEqual({
        accountId: body.accountId,
        periodMonth: PERIOD,
        cronRunId: cronRunId(CRON_NAME, runs[0]!.started_at),
      });
    }
    // The cron itself touched no Stripe account, wrote no claim or audit, mailed nobody.
    expect(stripeCalls.n).toBe(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
    expect(await db.select().from(auditRuns)).toHaveLength(0);
    expect(delivered).toEqual([]);
  });

  it("enqueues in sendBatch calls of at most 100, Cloudflare's per-call limit", async () => {
    const { db, env, queue } = setup();
    for (let i = 0; i < 250; i += 1) {
      await db.insert(accounts).values({
        id: `acct_${String(i).padStart(3, "0")}`,
        name: `n${i}`,
        auditAutoRun: true,
        createdAt: NOW,
      });
    }

    await runCron(env);

    expect(queue.bodies).toHaveLength(250);
    expect(queue.batchSizes.length).toBe(3);
    for (const size of queue.batchSizes) expect(size).toBeLessThanOrEqual(100);
  });

  it("an account switched off after it was queued is not audited", async () => {
    const { db, env, queue } = setup();
    await seedAccount(db, "acct_on");
    await runCron(env);
    await db.update(accounts).set({ auditAutoRun: false }).where(eq(accounts.id, "acct_on"));

    await deliver(
      env,
      queue.bodies.map((body) => ({ body })),
    );

    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
    expect(await db.select().from(auditRuns)).toHaveLength(0);
  });
});

describe("the consumer audits the one account its message names", () => {
  it("a redelivered message audits nothing twice and mails nobody twice", async () => {
    const { db, env, queue, delivered, stripeCalls } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    const body = bodyFor(queue.bodies, "a_on");

    expect(await deliver(env, [{ body }])).toEqual(["ack"]);
    const callsAfterFirst = stripeCalls.n;
    expect(callsAfterFirst).toBeGreaterThan(0);

    expect(await deliver(env, [{ body, attempts: 2 }])).toEqual(["ack"]);

    expect(stripeCalls.n).toBe(callsAfterFirst);
    expect(delivered).toEqual(["a_on@merchant.test"]);
    expect(await db.select().from(auditRuns)).toHaveLength(1);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(1);
  });

  it("a malformed message is acked, not retried, and writes nothing", async () => {
    const { db, env } = setup();
    await seedAccount(db, "a_on");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await deliver(env, [{ body: { accountId: 42 } }])).toEqual(["ack"]);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
  });

  it("the last attempt of a failing send raises the monthly-audit failure alert", async () => {
    const { db, env, queue, failFor, alerts } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    vi.spyOn(console, "error").mockImplementation(() => {});
    failFor.add("a_on@merchant.test");
    const body = bodyFor(queue.bodies, "a_on");

    // Attempts before the last one alert nobody: the queue may yet succeed.
    await deliver(env, [{ body, attempts: 1 }]);
    expect(alerts()).toHaveLength(0);

    // max_retries is 3, so the fourth delivery is the last one.
    expect(await deliver(env, [{ body, attempts: 4 }])).toEqual(["retry"]);
    const sent = alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(CRON_NAME);
    expect(sent[0].kind).toBe("failure");
  });

  it("an insert error with no row behind it is retried, not acked as a duplicate", async () => {
    // A transient D1 failure on the claim insert used to fall through to the
    // retake, find nothing, and ack: that merchant got no audit, no retry, no alert.
    const { db, env, queue, delivered } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    const body = bodyFor(queue.bodies, "a_on");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const blip = new Error("D1_ERROR: network connection lost");
    const realInsert = db.insert.bind(db);
    const insert = vi.spyOn(db, "insert").mockImplementationOnce(() => {
      throw blip;
    });

    expect(await deliver(env, [{ body }])).toEqual(["retry"]);
    expect(logged.mock.calls.flat()).toContain(blip);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);

    insert.mockImplementation(realInsert);
    expect(await deliver(env, [{ body, attempts: 2 }])).toEqual(["ack"]);
    expect(delivered).toEqual(["a_on@merchant.test"]);
  });

  it("a claim stuck pending is retried, never re-sent, and the last attempt alerts", async () => {
    const { db, env, queue, delivered, messages, alerts } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    await db.insert(auditDigestRuns).values({
      id: "planted",
      accountId: "a_on",
      periodMonth: PERIOD,
      totals: null,
      status: "pending",
      error: null,
      sentAt: null,
      cronRunId: null,
      createdAt: NOW,
    });
    const body = bodyFor(queue.bodies, "a_on");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // A redelivery after a killed run: look again later, do not send.
    expect(await deliver(env, [{ body, attempts: 2 }])).toEqual(["retry"]);
    expect(loggedText(logged).join("\n")).toContain("pending");
    expect(alerts()).toHaveLength(0);

    // The last attempt: still pending, so it alerts and lets the message go.
    expect(await deliver(env, [{ body, attempts: 4 }])).toEqual(["ack"]);
    const sent = alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(CRON_NAME);

    // Nothing was ever mailed to the merchant, and the row was never retaken.
    expect(delivered.filter((to) => to === "a_on@merchant.test")).toEqual([]);
    const alert = messages.find((m) => m.to !== "a_on@merchant.test");
    expect(alert?.text).toContain("a_on");
    expect(alert?.text).toContain(PERIOD);
    // The run may have died after the send and before the row was marked sent,
    // so the alert must not claim nothing went out.
    expect(alert?.text).toContain("may not have been sent");
    expect(alert?.text).not.toContain("no email was sent");
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("pending");
  });
});
