import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accounts,
  auditDigestRuns,
  auditRuns,
  emailSends,
  emailSuppressions,
  failedPayments,
  recoveredPayments,
  stripeConnections,
} from "~/db/schema";
import { SCOPE_UNREAD } from "~/lib/audit/render";
import { EMAIL_AUTH_SENDER_ADDRESS, EMAIL_FROM_ADDRESS } from "~/lib/constants";

import { blockText } from "./helpers/email-words";
import { loggedRuns, runJob } from "./helpers/cron";
import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

// The monthly audit: the cron enqueues one message per opted-in account, the queue
// consumer audits the one account its message names and sends the one monthly
// email. Everything below getConnectedStripe is real: reads, engine, persistence,
// the claim indexes (in-memory SQLite with the committed migrations). Not proven
// here: a real Cloudflare Email send, a real Stripe call, the cron firing on the 1st.

const harness = vi.hoisted(() => ({ db: null as unknown, stripe: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/stripe/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/client")>()),
  getConnectedStripe: () => harness.stripe,
}));

// The seeded token is a fixture string, not a real ciphertext.
vi.mock("~/lib/stripe/encryption", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/encryption")>()),
  decryptToken: async () => "sk_test_token",
}));

const monthly = await import("~/lib/audit/monthly.server");
const { buildMonthlyAuditEmail, compareTotals } = await import("~/lib/audit/monthly-email");
const { driveMonthlyAudit } = await import("./helpers/monthly-audit-queue");
const { renderFoxhoundEmail } = await import("~/lib/email/templates");
const { handleQueueBatch } = await import("~/lib/queue/consumer");
const { cronRunId } = await import("~/lib/admin/crons");
const { CRON_JOBS } = await import("~/lib/cron/registry");

// Spelled out rather than imported, so this file says what the deployed queue is
// called independently of the constant it checks.
const AUDIT_QUEUE = "foxhound-audit";
const CRON_NAME = "monthly-audit";
const NOW = new Date("2026-09-01T09:00:00.000Z");
const PERIOD = "2026-08";
const BASE_URL = "https://foxhoundapp.test";
const OCTOBER = new Date("2026-10-01T09:00:00.000Z");
const DAY_SECONDS = 86_400;

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

function throwingList(message: string): AsyncIterable<never> {
  return {
    // oxlint-disable-next-line require-yield
    async *[Symbol.asyncIterator]() {
      throw new Error(message);
    },
  };
}

const INVOICE = {
  amount_due: 4200,
  currency: "usd",
  status: "uncollectible",
  last_finalization_error: { decline_code: "insufficient_funds" },
} as unknown as Stripe.Invoice;

const DISPUTE = {
  amount: 9900,
  currency: "usd",
  status: "needs_response",
} as unknown as Stripe.Dispute;

/** A Stripe stand-in that counts every list call, so "audited nothing" is a
 *  measurement rather than an absence of rows, and records the invoice params. */
function countingStripe(over: Record<string, unknown> = {}) {
  const calls = { n: 0, invoiceParams: [] as Array<Record<string, unknown>> };
  const list =
    <T>(items: T[], record?: boolean) =>
    (params: Record<string, unknown>) => {
      calls.n += 1;
      if (record) calls.invoiceParams.push(params);
      return fakeList(items);
    };
  const stripe = {
    invoices: { list: list([INVOICE], true) },
    subscriptions: { list: list([]) },
    disputes: { list: list([DISPUTE]) },
    events: { list: list([]) },
    ...over,
  } as unknown as Stripe;
  return { stripe, calls };
}

function fakeQueue() {
  const bodies: unknown[] = [];
  const batchSizes: number[] = [];
  return {
    bodies,
    batchSizes,
    binding: {
      send: async (body: unknown) => {
        batchSizes.push(1);
        bodies.push(body);
      },
      sendBatch: async (messages: { body: unknown }[]) => {
        batchSizes.push(messages.length);
        for (const m of messages) bodies.push(m.body);
      },
    },
  };
}

interface Sent {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

function setup(stripeOver: Record<string, unknown> = {}) {
  const { sqlite, db } = createInMemoryDb();
  harness.db = db;
  const { stripe, calls } = countingStripe(stripeOver);
  harness.stripe = stripe;
  const queue = fakeQueue();
  const delivered: string[] = [];
  const messages: Sent[] = [];
  const failFor = new Set<string>();
  const env = {
    DB: d1Over(sqlite),
    EMAIL: {
      send: async (m: Sent) => {
        messages.push(m);
        if (failFor.has(m.to)) throw new Error(`mailbox full: ${m.to}`);
        delivered.push(m.to);
        return { id: "m" };
      },
    },
    BETTER_AUTH_URL: BASE_URL,
    CRON_LOCK: {
      get: () => ({ acquire: async () => true, release: async () => {} }),
      idFromName: (n: string) => n,
    },
    AUDIT_QUEUE: queue.binding,
  } as unknown as Env;
  const alerts = () =>
    sqlite.prepare("SELECT * FROM alerts_sent").all() as Array<{ key: string; kind: string }>;
  return { db, sqlite, env, queue, stripeCalls: calls, delivered, messages, failFor, alerts };
}

/** An account plus, unless `connect: false`, the live primary connection the run
 *  needs before it can audit anything. */
async function seedAccount(
  db: TestDb,
  id: string,
  row: Record<string, unknown> = {},
  opts: { connect?: boolean } = {},
) {
  await db.insert(accounts).values({
    id,
    name: id,
    notificationEmail: `${id}@merchant.test`,
    auditAutoRun: true,
    createdAt: NOW,
    ...row,
  });
  if (opts.connect === false) return;
  await db.insert(stripeConnections).values({
    id: `sc_${id}`,
    accountId: id,
    stripeUserId: `acct_stripe_${id}`,
    stripeAccessToken: "enc",
    isPrimary: true,
    connectedAt: NOW,
    createdAt: NOW,
    // A merchant's own reply-to is for its customers' mail, never this one.
    replyToEmail: "billing@merchant.test",
  });
}

/** A billable recovered payment, with the failed_payments parent its FK needs. */
async function seedRecovery(
  db: TestDb,
  accountId: string,
  cents: number,
  attributionKind = "foxhound_retry",
) {
  const fpId = `fp_${accountId}_${cents}_${attributionKind}`;
  await db.insert(failedPayments).values({
    id: fpId,
    stripeEventId: `evt_${fpId}`,
    stripeInvoiceId: `in_${fpId}`,
    stripeCustomerId: `cus_${fpId}`,
    customerEmail: "c@example.test",
    amountCents: cents,
    currency: "usd",
    declineCategory: "soft",
    status: "recovered",
    detectedAt: NOW,
    accountId,
  });
  await db.insert(recoveredPayments).values({
    id: `rp_${fpId}`,
    failedPaymentId: fpId,
    recoveredAt: NOW,
    amountCents: cents,
    currency: "usd",
    recoveryMethod: "retry",
    accountId,
    attributionKind,
  } as never);
}

const monthMessage = (accountId: string) => ({ accountId, periodMonth: PERIOD, cronRunId: null });

// The email body

type EmailInput = Parameters<typeof buildMonthlyAuditEmail>[0];
type EmailResult = EmailInput["result"];

const ok = <T>(data: T) => ({ ok: true as const, data });
/** A scope whose Stripe read FAILED, in the engine's own shape. */
const unread = (reason: string) => ({ ok: false as const, reason });

const resultWith = (over: Partial<EmailResult> = {}): EmailResult =>
  ({
    failedInvoices: ok({
      count: 2,
      totalCents: 4200,
      totals: [{ currency: "usd", cents: 4200 }],
      byCategory: {},
      byCategoryTotals: {},
    }),
    expiringCards: ok({
      count: 1,
      mrrAtRiskCents: 1500,
      mrrAtRiskTotals: [{ currency: "usd", cents: 1500 }],
      expiresByMonth: {},
    }),
    pastDueSubscriptions: ok({ count: 0, totalCents: 0, totals: [] }),
    cardUpdater: ok({
      eventsInWindow: 0,
      expiredCardDeclinesInWindow: 3,
      advisory: null,
      windowDays: 30,
    }),
    disputes: ok({
      open: { count: 1, totalCents: 9900, totals: [{ currency: "usd", cents: 9900 }] },
      acceptedWithoutFighting: { count: 0, totalCents: 0, totals: [] },
      historical: { won: 3, lost: 1 },
    }),
    health: ok({
      mrrCents: 100_000,
      mrrTotals: [{ currency: "usd", cents: 100_000 }],
      arrCents: 1_200_000,
      arrTotals: [{ currency: "usd", cents: 1_200_000 }],
      activeSubscriptionsCount: 42,
      voluntaryChurnRateBps: 210,
      involuntaryChurnRateBps: 90,
    }),
    meta: { stripeAccountId: "acct_x", lookbackDays: 90, currency: "usd", ranAt: NOW },
    ...over,
  }) as EmailResult;

/** The mail as its blocks' words, one block a line, a button as its label and address. */
const asText = (blocks: ReturnType<typeof buildMonthlyAuditEmail>["blocks"]) =>
  blocks.map((b) => (b.type === "button" ? `${b.label} ${b.url}` : blockText(b))).join("\n");

const emailFor = (over: Partial<EmailInput> = {}) => {
  const built = buildMonthlyAuditEmail({
    result: resultWith(),
    summary: "One. Two. Three.",
    runId: "run_123",
    baseUrl: BASE_URL,
    comparisons: [{ currency: "usd", cents: 12_40, changeCents: 3_10 }],
    ...over,
  });
  return { ...built, body: asText(built.blocks) };
};

describe("the email's recovery comparison is per currency and never summed across them", () => {
  it("a first run reports no change rather than a change of zero", () => {
    expect(compareTotals([{ currency: "usd", cents: 500 }], null)).toEqual([
      { currency: "usd", cents: 500, changeCents: null },
    ]);
  });

  it("two currencies stay two rows, with their own deltas", () => {
    expect(
      compareTotals(
        [
          { currency: "usd", cents: 800 },
          { currency: "eur", cents: 200 },
        ],
        [
          { currency: "usd", cents: 500 },
          { currency: "eur", cents: 50 },
        ],
      ),
    ).toEqual([
      { currency: "eur", cents: 200, changeCents: 150 },
      { currency: "usd", cents: 800, changeCents: 300 },
    ]);
  });
});

describe("the email never turns an unread scope into a zero", () => {
  it("a fall reads as down, not as a negative amount", () => {
    const { body } = emailFor({
      comparisons: [{ currency: "usd", cents: 100, changeCents: -500 }],
    });
    expect(body).toContain("down $5.00");
    expect(body).not.toContain("-$5.00");
  });

  it("every failed scope says it could not be read, and the reason stays internal", () => {
    const cases: [Partial<EmailResult>, string[]][] = [
      [
        { disputes: unread("Could not read disputes from Stripe: 500") },
        ["Open disputes", "Disputes accepted without response", "Dispute win rate"],
      ],
      [
        { health: unread("h") },
        ["MRR", "ARR", "Active subs", "Voluntary churn", "Involuntary churn"],
      ],
      [{ failedInvoices: unread("f") }, ["Failed payments detected"]],
      [{ expiringCards: unread("e") }, ["Expiring cards"]],
      [{ pastDueSubscriptions: unread("p") }, ["Past-due subscriptions"]],
    ];
    for (const [over, labels] of cases) {
      const { body } = emailFor({ result: resultWith(over) });
      for (const label of labels) {
        expect(body, `${label} did not say it was unread`).toContain(`${label}: ${SCOPE_UNREAD}`);
      }
      expect(body).not.toContain("Open disputes: 0");
      expect(body).not.toContain("Could not read disputes from Stripe");
    }
    // A scope that did read is unaffected, so this is per scope.
    expect(emailFor({ result: resultWith({ disputes: unread("x") }) }).body).toContain(
      "MRR: $1,000",
    );
  });

  it("escapes what it interpolates, once and never twice", () => {
    // The summary is model-written and the advisory is built from Stripe data.
    const { subject, blocks } = emailFor({
      summary: "Fees & refunds",
      result: resultWith({
        cardUpdater: ok({
          eventsInWindow: 0,
          expiredCardDeclinesInWindow: 3,
          advisory: "A & B",
          windowDays: 30,
        }),
      }),
    });
    const { html } = renderFoxhoundEmail({
      subject,
      blocks,
      brandName: "Foxhound",
      to: "owner@merchant.test",
    });
    expect(html).toContain(">Fees &amp; refunds</td>");
    expect(html).toContain(">Card Updater: A &amp; B</td>");
    expect(html).not.toContain("&amp;amp;");
  });
});

describe("one monthly mail per opted-in account", () => {
  it("goes out on the merchant path: From Foxhound, no Reply-To, no unsubscribe, one real link", async () => {
    const { db, env, messages } = setup();
    await seedAccount(db, "acct_on");

    const result = await driveMonthlyAudit(env, NOW, null);

    expect(result.sent).toBe(1);
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.to).toBe("acct_on@merchant.test");
    expect(m.from).toBe(`Foxhound <${EMAIL_FROM_ADDRESS}>`);
    expect(m.from).not.toContain(EMAIL_AUTH_SENDER_ADDRESS);
    expect(m.subject).toBe("Your monthly Foxhound report");
    expect(m.replyTo).toBeUndefined();
    expect(m.headers).toBeUndefined();
    expect(m.text).not.toContain("Unsubscribe");
    const [run] = await db.select().from(auditRuns);
    expect(m.text).toContain(`View full audit:\n${BASE_URL}/audit/results/${run.id}`);
    expect(m.html).toMatch(
      new RegExp(
        `<a class="e-btn" href="${BASE_URL}/audit/results/${run.id}"[^>]*>View full audit</a>`,
      ),
    );
  });

  it("a failed Stripe read reaches the inbox as a sentence and is stored as NULL", async () => {
    const { db, env, messages } = setup({ disputes: { list: () => throwingList("stripe 500") } });
    await seedAccount(db, "acct_on");

    await driveMonthlyAudit(env, NOW, null);

    expect(messages[0].text).toContain(`Open disputes: ${SCOPE_UNREAD}`);
    expect(messages[0].text).toContain("$42");
    const [stored] = await db.select().from(auditRuns);
    expect(stored.openDisputesCount).toBeNull();
    expect(stored.failedInvoicesCents).toBe(4200);
  });

  it("an account with no notification email is audited but not mailed", async () => {
    const { db, env, delivered } = setup();
    await seedAccount(db, "acct_noemail", { notificationEmail: null });

    const result = await driveMonthlyAudit(env, NOW, null);

    expect(result.skippedNoRecipient).toBe(1);
    expect(delivered).toEqual([]);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("no_recipient");
    expect(await db.select().from(auditRuns)).toHaveLength(1);
  });

  it("an account with no live connection cannot be audited, and says so", async () => {
    const { db, env, delivered } = setup();
    await seedAccount(db, "acct_noconn", {}, { connect: false });

    const result = await driveMonthlyAudit(env, NOW, null);

    expect(result.skippedNoConnection).toBe(1);
    expect(result.ran).toBe(0);
    expect(delivered).toEqual([]);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("no_connection");
  });

  it("the same account in a different month is a different slot", async () => {
    const { db, env } = setup();
    await seedAccount(db, "acct_on");

    await driveMonthlyAudit(env, NOW, null);
    expect((await driveMonthlyAudit(env, OCTOBER, null)).sent).toBe(1);

    const rows = await db.select().from(auditDigestRuns);
    expect(rows.map((r) => r.periodMonth).sort()).toEqual(["2026-08", "2026-09"]);
  });

  it("month two reports the change since month one", async () => {
    const { db, env, messages } = setup();
    await seedAccount(db, "acct_on");
    await seedRecovery(db, "acct_on", 5_00);

    await driveMonthlyAudit(env, NOW, null);
    await seedRecovery(db, "acct_on", 3_00);
    await driveMonthlyAudit(env, OCTOBER, null);

    expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain("$5.00");
    expect(messages[1].text).toContain("$8.00"); // cumulative
    expect(messages[1].text).toContain("up $3.00"); // the month's change
  });

  it("only billable attribution counts, so a stripe_baseline row is not claimed", async () => {
    const { db, env, messages } = setup();
    await seedAccount(db, "acct_on");
    await seedRecovery(db, "acct_on", 900, "stripe_baseline");

    await driveMonthlyAudit(env, NOW, null);

    expect(messages[0].text).toContain("No recovered payments are attributed to Foxhound yet");
    expect(messages[0].text).not.toContain("$9.00");
  });

  for (const days of [30, 180]) {
    it(`a stored ${days}-day lookback asks Stripe for ${days} days and is stored on the run`, async () => {
      const { db, env, stripeCalls } = setup();
      await seedAccount(db, "acct_lookback", { auditLookbackDays: days });

      const result = await driveMonthlyAudit(env, NOW, null);

      const uncollectible = stripeCalls.invoiceParams.find((p) => p.status === "uncollectible");
      expect(uncollectible?.created).toEqual({
        gte: Math.floor(NOW.getTime() / 1000) - days * DAY_SECONDS,
      });
      expect(result.ran).toBe(1);
      expect((await db.select().from(auditRuns))[0].lookbackDays).toBe(days);
    });
  }
});

describe("a refused send returns its named outcome", () => {
  it("a suppressed address is not mailed, and the month says suppressed", async () => {
    const { db, env, delivered } = setup();
    await seedAccount(db, "acct_on");
    await db.insert(emailSuppressions).values({
      id: "sup_1",
      email: "acct_on@merchant.test",
      token: "t",
      suppressedAt: NOW,
      reason: "bounce",
    });

    const outcome = await monthly.auditAccountForMonth(env, monthMessage("acct_on"), NOW);

    expect(outcome.status).toBe("suppressed");
    expect(delivered).toHaveLength(0);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("suppressed");
    // The audit itself still ran and is in history.
    expect(await db.select().from(auditRuns)).toHaveLength(1);
  });

  it("a standing send claim for the month is already_sent: nothing is mailed again", async () => {
    // The month row failed after its email_sends claim was taken with no error
    // (the outcome is unknown), so the retry must not mail a second time.
    const { db, env, messages } = setup();
    await seedAccount(db, "acct_on");
    await db.insert(emailSends).values({
      id: "es_planted",
      idempotencyKey: `monthly-audit:acct_on:${PERIOD}`,
      accountId: "acct_on",
      template: "monthly_audit",
      status: "pending",
      error: null,
      createdAt: NOW,
    });
    await db.insert(auditDigestRuns).values({
      id: "month_planted",
      accountId: "acct_on",
      periodMonth: PERIOD,
      totals: null,
      status: "failed",
      error: "earlier",
      sentAt: null,
      cronRunId: null,
      createdAt: NOW,
    });

    const outcome = await monthly.auditAccountForMonth(env, monthMessage("acct_on"), NOW);

    expect(outcome.status).toBe("already_sent");
    expect(messages).toHaveLength(0);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("already_sent");
  });

  it("a provider failure is failed, with the provider's words, and the next delivery sends once", async () => {
    const { db, env, failFor, delivered } = setup();
    await seedAccount(db, "acct_on");
    failFor.add("acct_on@merchant.test");

    const outcome = await monthly.auditAccountForMonth(env, monthMessage("acct_on"), NOW);
    expect(outcome.status).toBe("failed");
    expect((outcome.error as Error).message).toContain("mailbox full");
    expect((await db.select().from(auditDigestRuns))[0]).toMatchObject({ status: "failed" });

    failFor.clear();
    const action = await monthly.processMonthlyAuditMessage(env, monthMessage("acct_on"), 2, NOW);
    expect(action).toBe("ack");
    expect(delivered).toEqual(["acct_on@merchant.test"]);
  });
});

describe("the demo firewall", () => {
  // With liveSendGate "skip" the live-send switch no longer stands between a demo
  // account and a send; the consumer's own eligibility read is the only refusal.
  it("a demo account delivered straight to the consumer is not_eligible: no audit, no mail", async () => {
    const { db, env, messages } = setup();
    await seedAccount(db, "demo_teamflow");

    const outcome = await monthly.auditAccountForMonth(env, monthMessage("demo_teamflow"), NOW);

    expect(outcome).toEqual({ status: "not_eligible", ran: false });
    expect(messages).toHaveLength(0);
    expect(await db.select().from(auditRuns)).toHaveLength(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
    expect(await db.select().from(emailSends)).toHaveLength(0);
  });

  it('only the monthly audit and the team invite skip the live-send gate: liveSendGate: "skip" appears nowhere else under app/', () => {
    const root = fileURLToPath(new URL("../app", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) walk(full);
        else if (
          /\.tsx?$/.test(entry) &&
          /liveSendGate:\s*"skip"/.test(readFileSync(full, "utf8"))
        ) {
          hits.push(full.slice(full.indexOf("app/")));
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual([
      "app/lib/audit/monthly.server.ts",
      "app/lib/settings/team-invite-email.server.ts",
    ]);
  });
});

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
