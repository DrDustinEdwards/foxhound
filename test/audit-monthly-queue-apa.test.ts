import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accounts,
  auditDigestRuns,
  auditRuns,
  cronAlerts,
  cronRunHistory,
  stripeConnections,
} from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";

// job_97878f0d1fde: THE MONTHLY AUDIT IS ONE ACCOUNT PER QUEUE MESSAGE.
//
// Since #123 every Stripe read in the audit pages to the end (RULES.md 3.19), so
// one account costs a fixed handful of subrequests plus one per page of its own
// data, with no upper bound. Auditing every opted-in account inside the one cron
// invocation put all of them under one subrequest limit: a few hundred small
// accounts filled it, and one very large account starved every account after it.
//
// The cron now only enqueues, one message per opted-in account, and the queue
// consumer audits the one account its message names. Every test here drives the
// REAL registered cron handler through runCronJob and the REAL consumer entry
// (handleQueueBatch, which workers/app.ts hands every non-DLQ batch to), with
// getConnectedStripe as the only live seam and an in-memory queue standing in
// for the AUDIT_QUEUE producer binding.

const harness = vi.hoisted(() => ({ db: null as unknown, stripe: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/client")>()),
  getConnectedStripe: () => harness.stripe,
}));

vi.mock("~/lib/stripe/encryption", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/encryption")>()),
  decryptToken: async () => "sk_test_token",
}));

const { runCronJob } = await import("~/lib/cron/run");
const { CRON_JOBS } = await import("~/lib/cron/registry");
const { handleQueueBatch } = await import("~/lib/queue/consumer");

// Spelled out rather than imported, so this file says what the deployed queue is
// called independently of the constant it checks.
const AUDIT_QUEUE = "foxhound-audit";
const CRON_NAME = "monthly-audit";
const NOW = new Date("2026-09-01T09:00:00.000Z");
const PERIOD = "2026-08";

type TestDb = ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  // The registered handler reads the clock itself, so the clock is pinned rather
  // than the handler bypassed.
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeList<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

/** A Stripe stand-in that counts every list call, so "audited nothing" is a
 *  measurement rather than an absence of rows. */
function countingStripe() {
  const calls = { n: 0 };
  const list = <T,>(items: T[]) => () => {
    calls.n += 1;
    return fakeList(items);
  };
  const stripe = {
    invoices: {
      list: list([
        { amount_due: 4200, currency: "usd", status: "uncollectible" } as unknown as Stripe.Invoice,
      ]),
    },
    subscriptions: { list: list([]) },
    disputes: { list: list([]) },
    events: { list: list([]) },
  } as unknown as Stripe;
  return { stripe, calls };
}

function fakeQueue(fail?: Error) {
  const bodies: unknown[] = [];
  const batchSizes: number[] = [];
  return {
    bodies,
    batchSizes,
    binding: {
      send: async (body: unknown) => {
        if (fail) throw fail;
        batchSizes.push(1);
        bodies.push(body);
      },
      sendBatch: async (messages: { body: unknown }[]) => {
        if (fail) throw fail;
        batchSizes.push(messages.length);
        for (const m of messages) bodies.push(m.body);
      },
    },
  };
}

function setup() {
  const { db } = createInMemoryDb();
  harness.db = db;
  const { stripe, calls } = countingStripe();
  harness.stripe = stripe;
  const queue = fakeQueue();
  const delivered: string[] = [];
  const messages: { to: string; text?: string }[] = [];
  const failFor = new Set<string>();
  const e = {
    DB: {},
    EMAIL: {
      send: async (m: { to: string; text?: string }) => {
        messages.push(m);
        if (failFor.has(m.to)) throw new Error(`mailbox full: ${m.to}`);
        delivered.push(m.to);
        return { id: "m" };
      },
    },
    BETTER_AUTH_URL: "https://foxhoundapp.test",
    CRON_LOCK: {
      get: () => ({ acquire: async () => true, release: async () => {} }),
      idFromName: (n: string) => n,
    },
    AUDIT_QUEUE: queue.binding,
  } as unknown as Env;
  return { db, env: e, queue, stripeCalls: calls, delivered, messages, failFor };
}

async function seedAccount(db: TestDb, id: string, row: Record<string, unknown> = {}) {
  await db.insert(accounts).values({
    id,
    name: id,
    notificationEmail: `${id}@merchant.test`,
    auditAutoRun: true,
    // E24: the merchant notice path is held by the live-send switch.
    liveSendsEnabled: true,
    createdAt: NOW,
    ...row,
  });
  await db.insert(stripeConnections).values({
    id: `sc_${id}`,
    accountId: id,
    stripeUserId: `acct_stripe_${id}`,
    stripeAccessToken: "enc",
    isPrimary: true,
    connectedAt: NOW,
    createdAt: NOW,
  });
}

async function runCron(e: Env) {
  const job = CRON_JOBS.find((j) => j.name === CRON_NAME)!;
  return runCronJob(e, job.name, job.handler);
}

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

const bodyFor = (bodies: unknown[], accountId: string) =>
  bodies.find((b) => (b as { accountId?: string }).accountId === accountId);

// ============================================================================

describe("the cron enqueues one message per opted-in account and audits nothing itself", () => {
  it("only opted-in, processing-eligible accounts are queued, each with its month and run", async () => {
    const { db, env, queue, stripeCalls, delivered } = setup();
    await seedAccount(db, "a_on");
    await seedAccount(db, "b_on");
    await seedAccount(db, "c_off", { auditAutoRun: false });
    await seedAccount(db, "d_null", { auditAutoRun: null });
    await seedAccount(db, "e_paused", { processingPaused: true });
    await seedAccount(db, "demo_teamflow");

    const outcome = await runCron(env);

    expect(outcome.status).toBe("success");
    const runs = await db.select().from(cronRunHistory);
    expect(runs).toHaveLength(1);
    expect(runs[0].rowsProcessed).toBe(2);

    const queued = queue.bodies as { accountId: string }[];
    expect(queued.map((b) => b.accountId).sort()).toEqual(["a_on", "b_on"]);
    for (const body of queued) {
      expect(body).toEqual({ accountId: body.accountId, periodMonth: PERIOD, cronRunId: runs[0].id });
    }

    // The cron invocation itself touched no Stripe account, wrote no claim and
    // no audit, and mailed nobody. That is the whole point of the split.
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

  it("a queue that refuses the send fails the cron run, so the alert path sees it", async () => {
    const { db, env } = setup();
    await seedAccount(db, "a_on");
    const broken = fakeQueue(new Error("queue unavailable"));
    const outcome = await runCron({ ...env, AUDIT_QUEUE: broken.binding } as unknown as Env);

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("queue unavailable");
  });
});

describe("the consumer audits the one account its message names", () => {
  it("one message, one account audited, stored and mailed, and the message acked", async () => {
    const { db, env, queue, delivered } = setup();
    await seedAccount(db, "a_on");
    await seedAccount(db, "b_on");
    await runCron(env);

    const verdicts = await deliver(env, [{ body: bodyFor(queue.bodies, "a_on") }]);

    expect(verdicts).toEqual(["ack"]);
    expect(delivered).toEqual(["a_on@merchant.test"]);
    const stored = await db.select().from(auditRuns);
    expect(stored.map((r) => r.accountId)).toEqual(["a_on"]);
    const claims = await db.select().from(auditDigestRuns);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ accountId: "a_on", periodMonth: PERIOD, status: "sent" });
    const runs = await db.select().from(cronRunHistory);
    expect(claims[0].cronRunId).toBe(runs[0].id);
  });

  it("A REDELIVERED message audits nothing twice and mails nobody twice", async () => {
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

  it("an account switched off between enqueue and delivery is not audited", async () => {
    const { db, env, queue, delivered } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    await db.update(accounts).set({ auditAutoRun: false }).where(eq(accounts.id, "a_on"));

    expect(await deliver(env, [{ body: bodyFor(queue.bodies, "a_on") }])).toEqual(["ack"]);
    expect(delivered).toEqual([]);
    expect(await db.select().from(auditRuns)).toHaveLength(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
  });

  it("a malformed message is acked, not retried, and writes nothing", async () => {
    const { db, env } = setup();
    await seedAccount(db, "a_on");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await deliver(env, [{ body: { accountId: 42 } }])).toEqual(["ack"]);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
  });
});

describe("a failure logs the whole err and lets the queue retry", () => {
  it("the failing message is retried with the error object logged, and the retry sends once", async () => {
    const { db, env, queue, delivered, failFor } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    const body = bodyFor(queue.bodies, "a_on");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    failFor.add("a_on@merchant.test");
    expect(await deliver(env, [{ body }])).toEqual(["retry"]);

    // THE WHOLE ERR, not its message: the logged arguments carry the Error.
    const loggedErrors = logged.mock.calls.flat().filter((a): a is Error => a instanceof Error);
    expect(loggedErrors.map((e) => e.message)).toContain("mailbox full: a_on@merchant.test");
    const failed = (await db.select().from(auditDigestRuns))[0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("mailbox full: a_on@merchant.test");

    // The queue redelivers; the failed claim is retaken, not refused.
    failFor.clear();
    expect(await deliver(env, [{ body, attempts: 2 }])).toEqual(["ack"]);
    expect(delivered).toEqual(["a_on@merchant.test"]);
    const claims = await db.select().from(auditDigestRuns);
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe("sent");
    expect(claims[0].error).toBeNull();
  });

  it("ONE ACCOUNT'S FAILURE never stops another's, even inside one batch", async () => {
    const { db, env, queue, delivered, failFor } = setup();
    await seedAccount(db, "a_bad");
    await seedAccount(db, "b_good");
    await runCron(env);
    vi.spyOn(console, "error").mockImplementation(() => {});
    failFor.add("a_bad@merchant.test");

    const verdicts = await deliver(env, [
      { body: bodyFor(queue.bodies, "a_bad") },
      { body: bodyFor(queue.bodies, "b_good") },
    ]);

    expect(verdicts).toEqual(["retry", "ack"]);
    expect(delivered).toEqual(["b_good@merchant.test"]);
    const rows = await db.select().from(auditDigestRuns);
    expect(rows.find((r) => r.accountId === "a_bad")!.status).toBe("failed");
    expect(rows.find((r) => r.accountId === "b_good")!.status).toBe("sent");
  });

  it("the LAST attempt raises the monthly-audit failure alert", async () => {
    const { db, env, queue, failFor } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    vi.spyOn(console, "error").mockImplementation(() => {});
    failFor.add("a_on@merchant.test");
    const body = bodyFor(queue.bodies, "a_on");

    // Attempts before the last one alert nobody: the queue may yet succeed.
    await deliver(env, [{ body, attempts: 1 }]);
    expect(await db.select().from(cronAlerts)).toHaveLength(0);

    // max_retries is 3, so the fourth delivery is the last one.
    expect(await deliver(env, [{ body, attempts: 4 }])).toEqual(["retry"]);
    const alerts = await db.select().from(cronAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].cronName).toBe(CRON_NAME);
    expect(alerts[0].kind).toBe("failure");
  });
});

// ============================================================================
// Review follow-ups on PR 143
// ============================================================================

const loggedText = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));

describe("a claim that cannot be read as taken is not acked as a duplicate", () => {
  it("AN INSERT ERROR WITH NO ROW BEHIND IT is retried, not swallowed", async () => {
    // A transient D1 failure on the claim insert used to fall through to the
    // retake, find nothing to retake, and ack the message as a duplicate: that
    // merchant got no audit, no log, no retry and no alert.
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
});

describe("a refused claim on a redelivery is seen, and a stuck one alerts", () => {
  async function plant(db: TestDb, status: string) {
    await db.insert(auditDigestRuns).values({
      id: "planted",
      accountId: "a_on",
      periodMonth: PERIOD,
      totals: null,
      status,
      error: null,
      sentAt: null,
      cronRunId: null,
      createdAt: NOW,
    });
  }

  it("a first delivery refused by a finished month stays quiet", async () => {
    const { db, env, queue } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    await plant(db, "sent");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await deliver(env, [{ body: bodyFor(queue.bodies, "a_on") }])).toEqual(["ack"]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("a REDELIVERY refused by a finished month is logged, and acked", async () => {
    const { db, env, queue } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    await plant(db, "sent");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await deliver(env, [{ body: bodyFor(queue.bodies, "a_on"), attempts: 2 }])).toEqual(["ack"]);
    const text = loggedText(logged).join("\n");
    expect(text).toContain("a_on");
    expect(text).toContain("sent");
  });

  it("a claim STUCK PENDING is retried, never re-sent, and the last attempt alerts", async () => {
    const { db, env, queue, delivered, messages } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    await plant(db, "pending");
    const body = bodyFor(queue.bodies, "a_on");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    // A redelivery after a killed run: look again later, do not send.
    expect(await deliver(env, [{ body, attempts: 2 }])).toEqual(["retry"]);
    expect(loggedText(logged).join("\n")).toContain("pending");
    expect(await db.select().from(cronAlerts)).toHaveLength(0);

    // The last attempt: still pending, so it alerts and lets the message go.
    expect(await deliver(env, [{ body, attempts: 4 }])).toEqual(["ack"]);
    const alerts = await db.select().from(cronAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].cronName).toBe(CRON_NAME);

    // Nothing was ever mailed to the merchant, and the row was never retaken.
    expect(delivered.filter((to) => to === "a_on@merchant.test")).toEqual([]);
    const alert = messages.find((m) => m.to !== "a_on@merchant.test");
    expect(alert?.text).toContain("a_on");
    expect(alert?.text).toContain(PERIOD);
    // The run may have died after the send and before the row was marked sent,
    // so the alert must not claim nothing went out (job_17249e7da871).
    expect(alert?.text).toContain("may not have been sent");
    expect(alert?.text).not.toContain("no email was sent");
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("pending");
  });
});

describe("the failure alert names the account", () => {
  it("the last failed attempt's alert carries the account id and month", async () => {
    const { db, env, queue, failFor, messages } = setup();
    await seedAccount(db, "a_on");
    await runCron(env);
    vi.spyOn(console, "error").mockImplementation(() => {});
    failFor.add("a_on@merchant.test");

    await deliver(env, [{ body: bodyFor(queue.bodies, "a_on"), attempts: 4 }]);

    const alert = messages.find((m) => m.to !== "a_on@merchant.test");
    expect(alert?.text).toContain("account a_on");
    expect(alert?.text).toContain(PERIOD);
    expect(alert?.text).toContain("mailbox full: a_on@merchant.test");
  });
});
