import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  auditDigestRuns,
  auditRuns,
  failedPayments,
  recoveredPayments,
  stripeConnections,
} from "~/db/schema";
import { CRON_SCHEDULE_MONTHLY, CRON_SCHEDULE_MONTHLY_AUDIT } from "~/lib/constants";
import { SCOPE_UNREAD } from "~/lib/audit/render";

import { createInMemoryDb } from "./helpers/inmemory-db";

// PHASE (g), RULING 362 RULING 3: THE ONE MONTHLY EMAIL.
//
// MIGRATED FROM test/audit-digest-316.test.ts, WHICH IS WHAT THIS FILE MOSTLY
// IS. 316 built a second monthly send (`audit-digest`) gated on the same toggle
// and addressed to the same recipient as legacy's monthly audit; session 67's
// walk found the two on a collision course, and 362 ruled ONE email, legacy's
// treatment, absorbing the digest's number as a line item.
//
// SO THE PLANTS MOVED RATHER THAN DIED, and the split is worth naming because it
// is the whole shape of the merge. What was correct about the digest was its
// MACHINERY: the month claim, the per-currency comparison, the shared opt-in
// predicate, the account-state gates, the failure posture, the cron-health
// mapping. All of it is here, driving the monthly audit (since job_97878f0d1fde
// the cron enqueues and the consumer audits one account per message;
// driveMonthlyAudit runs both halves). What died was the
// second SEND, so the email-body plants are rewritten against the merged email
// and the schedule plant moved to the merged job's own hour.
//
// WHAT THIS SUITE PROVES, in the order 257/286/296 require:
//   1. registration, through the REAL runner, not by reading the array
//   2. toggle-off AND NULL both skipped THROUGH THE SHARED PREDICATE
//   3. processing_paused, cancelled and demo accounts all skipped
//   4. idempotency per account per month, by DATABASE refusal
//   5. a failure reaching Session 24's alert machinery
//   6. cron-health seeing the schedule as MAPPABLE
//
// COVERAGE BOUND (246). Everything below runs against a real in-memory SQLite
// with the committed migrations applied verbatim, so the unique index and the
// FKs are the real ones, and against the REAL engine, reads module and
// persistence, with `getConnectedStripe` as the only live seam. What is NOT
// proven here: a real Cloudflare Email Service send (env.EMAIL is a stub
// throughout), a real Stripe call, and the deployed cron actually firing on the
// 1st, which only a calendar can demonstrate. All three are stated rather than
// implied.
//
// DEAD-LETTERING IS DELIBERATELY NOT PROVEN, because it is not reachable from
// this path and faking it would be worse than omitting it. email_dead_letters
// records QUEUE-delivered jobs; this cron calls sendTransactionalEmail directly
// and the queue PRODUCER was deleted under ruling 280, so no send here can
// become a queue message. The half of Session 24's machinery this cron genuinely
// rides is the failure ALERT, proven in section 5.

const harness = vi.hoisted(() => ({ db: null as unknown, stripe: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// The one live seam, exactly as phase (f)'s suite drives it: everything below
// getConnectedStripe is the real reads module, the real pure engine and the real
// persistence.
vi.mock("~/lib/stripe/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/client")>()),
  getConnectedStripe: () => harness.stripe,
}));

// The seeded token is a fixture string, not a real ciphertext.
vi.mock("~/lib/stripe/encryption", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/stripe/encryption")>()),
  decryptToken: async () => "sk_test_token",
}));

const { describeMonthlyAuditRun } = await import("~/lib/audit/monthly.server");
const { buildMonthlyAuditEmail, compareTotals } = await import("~/lib/audit/monthly-email");
const { driveMonthlyAudit } = await import("./helpers/monthly-audit-queue");
const { renderFoxhoundEmail } = await import("~/lib/email/templates");
const { handleQueueBatch } = await import("~/lib/queue/consumer");
const { runCronJob } = await import("~/lib/cron/run");
const { CRON_JOBS, jobsForSchedule } = await import("~/lib/cron/registry");

const CRON_NAME = "monthly-audit";
const NOW = new Date("2026-09-01T09:00:00.000Z");
const PERIOD = "2026-08";
const BASE_URL = "https://foxhoundapp.test";

type TestDb = ReturnType<typeof createInMemoryDb>["db"];

function env(
  send: (m: unknown) => Promise<{ id: string }> = async () => ({ id: "m" }),
  queued: unknown[] = [],
): Env {
  const stub = { acquire: async () => true, release: async () => {} };
  return {
    DB: {},
    EMAIL: { send },
    BETTER_AUTH_URL: BASE_URL,
    CRON_LOCK: { get: () => stub, idFromName: (n: string) => n },
    AUDIT_QUEUE: {
      sendBatch: async (messages: { body: unknown }[]) => {
        for (const m of messages) queued.push(m.body);
      },
    },
  } as unknown as Env;
}

/** Hand queued bodies to the REAL consumer entry, one batch each, as the
 *  foxhound-audit consumer's max_batch_size of 1 does. */
async function consume(e: Env, bodies: unknown[]) {
  for (const body of bodies) {
    await handleQueueBatch(
      {
        queue: "foxhound-audit",
        messages: [{ id: "m", timestamp: NOW, body, attempts: 1, ack: () => {}, retry: () => {} }],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<unknown>,
      e,
    );
  }
}

function fakeList<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function throwingList(message: string): AsyncIterable<never> {
  return {
    // eslint-disable-next-line require-yield
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

function stripeWith(over: Record<string, unknown> = {}) {
  return {
    invoices: { list: () => fakeList([INVOICE]) },
    subscriptions: { list: () => fakeList([]) },
    disputes: { list: () => fakeList([DISPUTE]) },
    events: { list: () => fakeList([]) },
    ...over,
  } as unknown as Stripe;
}

function fresh(): TestDb {
  const { db } = createInMemoryDb();
  harness.db = db;
  harness.stripe = stripeWith();
  return db;
}

/** An account plus, unless `connect: false`, the live primary connection the
 *  merged run needs before it can audit anything. The digest needed no
 *  connection at all; this job reads live Stripe, so the fixture grew one. */
async function seedAccount(
  db: TestDb,
  id: string,
  row: Record<string, unknown> = {},
  opts: { connect?: boolean; stripeUserId?: string } = {},
) {
  await db.insert(accounts).values({
    id,
    name: id,
    notificationEmail: `${id}@merchant.test`,
    createdAt: NOW,
    ...row,
  });
  if (opts.connect === false) return;
  await db.insert(stripeConnections).values({
    id: `sc_${id}`,
    accountId: id,
    stripeUserId: opts.stripeUserId ?? `acct_stripe_${id}`,
    stripeAccessToken: "enc",
    isPrimary: true,
    connectedAt: NOW,
    createdAt: NOW,
  });
}

/** A billable recovered payment, with the failed_payments parent its FK needs. */
async function seedRecovery(db: TestDb, accountId: string, cents: number, currency = "usd") {
  const fpId = `fp_${accountId}_${cents}_${currency}`;
  await db.insert(failedPayments).values({
    id: fpId,
    stripeEventId: `evt_${fpId}`,
    stripeInvoiceId: `in_${fpId}`,
    stripeCustomerId: `cus_${fpId}`,
    customerEmail: "c@example.test",
    amountCents: cents,
    currency,
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
    currency,
    recoveryMethod: "retry",
    accountId,
    attributionKind: "foxhound_retry",
  });
}

/** Collect every message body the run sent. Since J02 the body is read from
 *  the plain-text part, which Capsomer writes from the same blocks as the HTML
 *  part, so a sentence is asserted as words rather than as markup. */
function collector() {
  const bodies: string[] = [];
  const to: string[] = [];
  const e = env(async (m) => {
    bodies.push((m as { text?: string }).text ?? "");
    to.push((m as { to: string }).to);
    return { id: "m" };
  });
  return { bodies, to, env: e };
}

type EmailInput = Parameters<typeof buildMonthlyAuditEmail>[0];
type EmailResult = EmailInput["result"];

const ok = <T,>(data: T) => ({ ok: true as const, data });
/** A scope whose Stripe read FAILED. The engine's own shape, so the email is
 *  driven by the real discriminated outcome rather than a reproduction of it. */
const unread = (reason: string) => ({ ok: false as const, reason });

/** A complete result, with any scope replaceable by a failed one. */
const resultWith = (over: Partial<EmailResult> = {}): EmailResult =>
  ({
    failedInvoices: ok({ count: 2, totalCents: 4200, totals: [{ currency: "usd", cents: 4200 }], byCategory: {}, byCategoryTotals: {} }),
    expiringCards: ok({ count: 1, mrrAtRiskCents: 1500, mrrAtRiskTotals: [{ currency: "usd", cents: 1500 }], expiresByMonth: {} }),
    pastDueSubscriptions: ok({ count: 0, totalCents: 0, totals: [] }),
    cardUpdater: ok({
      eventsInWindow: 0,
      expiredCardDeclinesInWindow: 0,
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

/** The mail as its blocks' words, one block a line, a button as its label and
 *  address. Since E24 the builder returns Capsomer blocks rather than HTML. */
const asText = (blocks: ReturnType<typeof buildMonthlyAuditEmail>["blocks"]) =>
  blocks.map((b) => (b.type === "button" ? `${b.label} ${b.url}` : b.text)).join("\n");

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

describe("the comparison is per currency and never summed across them", () => {
  it("a first run reports NO change rather than a change of zero", () => {
    expect(compareTotals([{ currency: "usd", cents: 500 }], null)).toEqual([
      { currency: "usd", cents: 500, changeCents: null },
    ]);
  });

  it("TWO CURRENCIES STAY TWO ROWS, with their own deltas", () => {
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

// ============================================================================
// The merged email body: legacy's strings, the absorbed line, the unread rule
// ============================================================================

describe("362 ruling 3: the ONE email carries BOTH halves", () => {

  it("a FALL reads as down, not as a negative amount", () => {
    const { body: bodyHtml } = emailFor({ comparisons: [{ currency: "usd", cents: 100, changeCents: -500 }] });
    expect(bodyHtml).toContain("down $5.00");
    expect(bodyHtml).not.toContain("-$5.00");
  });

  it("A FAILED SCOPE READS AS COULD-NOT-BE-READ, never as a zero", () => {
    // 362 RULING 2 REACHES THE EMAIL, which is the last layer it had to survive.
    // The engine gave a scope its status, (d) stored it as the NULL, (e)
    // rendered it as a sentence, and an email that coalesced it back to 0 would
    // tell a merchant they have no open disputes on the strength of a Stripe
    // call that failed. Legacy cannot make this mistake in its own email only
    // because its engine already zeroed the scope one step earlier, which is the
    // same lie with better manners.
    const { body: bodyHtml } = emailFor({
      result: resultWith({ disputes: unread("Could not read disputes from Stripe: 500") }),
    });

    expect(bodyHtml).toContain(`Open disputes: ${SCOPE_UNREAD}`);
    expect(bodyHtml).toContain(
      `Disputes accepted without response: ${SCOPE_UNREAD}`,
    );
    // A zero would be indistinguishable from a merchant with no open disputes.
    expect(bodyHtml).not.toContain("Open disputes: 0");
    // The win rate has no honest value without the scope, so its row is the
    // sentence too rather than being silently dropped.
    expect(bodyHtml).toContain(`Dispute win rate: ${SCOPE_UNREAD}`);
    // The scopes that DID read are unaffected, so this is per scope and not a
    // whole-email bail-out.
    expect(bodyHtml).toContain("MRR: $1,000");
    // And the internal reason never reaches the merchant.
    expect(bodyHtml).not.toContain("500");
  });

  it("EVERY FAILED SCOPE, not just the one the test happened to pick", () => {
    // A single-scope check would pass against a coalescer that only handled
    // disputes. Each scope is failed on its own and its rows are swept.
    const cases: [Partial<EmailResult>, string[]][] = [
      [{ health: unread("h") }, ["MRR", "ARR", "Active subs", "Voluntary churn", "Involuntary churn"]],
      [{ failedInvoices: unread("f") }, ["Failed payments detected"]],
      [{ expiringCards: unread("e") }, ["Expiring cards"]],
      [{ pastDueSubscriptions: unread("p") }, ["Past-due subscriptions"]],
    ];
    for (const [over, labels] of cases) {
      const { body: bodyHtml } = emailFor({ result: resultWith(over) });
      for (const label of labels) {
        expect(bodyHtml, `${label} did not say it was unread`).toContain(
          `${label}: ${SCOPE_UNREAD}`,
        );
      }
    }
  });
});

// ============================================================================
// 1. Registration, through the real runner
// ============================================================================

describe("(1): the cron is REGISTERED and the real runner executes it", () => {
  it("rides LEGACY'S HOUR on the 1st, and the digest's registration is gone", () => {
    const monthly = jobsForSchedule(CRON_SCHEDULE_MONTHLY_AUDIT);
    expect(monthly.map((j) => j.name)).toEqual([CRON_NAME]);
    // "0 9 1 * *": the 1st at 09:00 UTC, which is legacy's schedule verbatim.
    expect(CRON_SCHEDULE_MONTHLY_AUDIT).toBe("0 9 1 * *");
    expect(CRON_SCHEDULE_MONTHLY_AUDIT.split(" ")[2]).toBe("1");
    // And it is NOT on the 04:00 slot the digest rode, which already carries
    // billing-monthly and intelligence-sync.
    expect(jobsForSchedule(CRON_SCHEDULE_MONTHLY).map((j) => j.name)).not.toContain(CRON_NAME);
    expect(CRON_JOBS.map((j) => j.name)).not.toContain("audit-digest");
  });

  it("A FAILED STRIPE READ REACHES THE MERCHANT'S INBOX AS A SENTENCE", async () => {
    // END TO END, from a throwing Stripe list to the delivered body: the read
    // fails, the engine marks the scope, persistence stores NULL, and the email
    // says so. The three layers agreeing is the property; each has its own plant
    // and none of them proves the chain.
    const db = fresh();
    harness.stripe = stripeWith({ disputes: { list: () => throwingList("stripe 500") } });
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    const { bodies, env: e } = collector();
    await driveMonthlyAudit(e, NOW, null);

    expect(bodies[0]).toContain(`Open disputes: ${SCOPE_UNREAD}`);
    expect(bodies[0]).not.toContain("Open disputes: 0");
    // The stored row carries the same unknown, as a NULL rather than a zero.
    const stored = await db.select().from(auditRuns);
    expect(stored[0].openDisputesCount).toBeNull();
    // And the scopes that read are still numbers on both.
    expect(stored[0].failedInvoicesCents).toBe(4200);
    // Legacy's zero-fraction formatting on a diagnostic figure.
    expect(bodies[0]).toContain("$42");
  });
});

// ============================================================================
// 3. Account states, matching the sibling crons
// ============================================================================

describe("(3): the account states every other per-account cron respects", () => {

  it("an account with NO notification email is audited but not mailed", async () => {
    // 339: notification_email is the only recipient. The run still happens and
    // is still readable in history, which is the merge's one behaviour change
    // over the digest here.
    const db = fresh();
    await seedAccount(db, "acct_noemail", { auditAutoRun: true, notificationEmail: null });

    const { to, env: e } = collector();
    const result = await driveMonthlyAudit(e, NOW, null);

    expect(result.skippedNoRecipient).toBe(1);
    expect(to).toEqual([]);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("no_recipient");
    expect(await db.select().from(auditRuns)).toHaveLength(1);
  });

  it("AN ACCOUNT WITH NO LIVE CONNECTION cannot be audited, and says so", async () => {
    // New with the merge: the digest read Foxhound's own rows and needed no
    // connection. This job cannot audit without one, and legacy `continue`s past
    // exactly this case.
    const db = fresh();
    await seedAccount(db, "acct_noconn", { auditAutoRun: true }, { connect: false });

    const { to, env: e } = collector();
    const result = await driveMonthlyAudit(e, NOW, null);

    expect(result.skippedNoConnection).toBe(1);
    expect(result.ran).toBe(0);
    expect(to).toEqual([]);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("no_connection");
  });
});

// ============================================================================
// 4. Idempotency, by DATABASE refusal
// ============================================================================

describe("(4): idempotent per account per month, refused by the database", () => {
  it("A SECOND TICK IN THE SAME MONTH SENDS NOTHING, and audits nothing", async () => {
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    const { bodies, env: e } = collector();
    const first = await driveMonthlyAudit(e, NOW, null);
    const second = await driveMonthlyAudit(e, NOW, null);

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(1);
    // The claim is taken BEFORE the audit runs, so a duplicate tick does not
    // burn five Stripe reads and an AI call to discover it has nothing to do.
    expect(second.ran).toBe(0);
    expect(await db.select().from(auditRuns)).toHaveLength(1);
  });

  it("A PLANTED DUPLICATE ROW is refused by the INDEX, not by application logic", async () => {
    // The plant: the month's row is inserted by hand BEFORE the cron runs, as a
    // concurrent run would have. Nothing in the run has seen it.
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    await db.insert(auditDigestRuns).values({
      id: "planted",
      accountId: "acct_on",
      periodMonth: PERIOD,
      totals: null,
      status: "sent",
      error: null,
      sentAt: NOW,
      cronRunId: null,
      createdAt: NOW,
    });

    const { bodies, env: e } = collector();
    const result = await driveMonthlyAudit(e, NOW, null);

    expect(result.optedIn).toBe(1); // it got as far as the claim
    expect(result.skippedDuplicate).toBe(1); // and the index refused it
    expect(bodies).toHaveLength(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(1);
  });

  it("the SAME account in a DIFFERENT month is a different slot", async () => {
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    await driveMonthlyAudit(env(), NOW, null);
    const october = await driveMonthlyAudit(env(), new Date("2026-10-01T09:00:00.000Z"), null);

    expect(october.sent).toBe(1);
    const rows = await db.select().from(auditDigestRuns);
    expect(rows.map((r) => r.periodMonth).sort()).toEqual(["2026-08", "2026-09"]);
  });

  it("TWO accounts in the same month do not collide with each other", async () => {
    const db = fresh();
    await seedAccount(db, "a_one", { auditAutoRun: true });
    await seedAccount(db, "a_two", { auditAutoRun: true });

    expect((await driveMonthlyAudit(env(), NOW, null)).sent).toBe(2);
  });
});

// ============================================================================
// The absorbed comparison, end to end against real recovered_payments
// ============================================================================

describe("the absorbed line runs off the prior month's stored snapshot", () => {
  it("month two reports the change since month one", async () => {
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });
    await seedRecovery(db, "acct_on", 5_00);

    const { bodies, env: e } = collector();

    await driveMonthlyAudit(e, NOW, null);
    // A further recovery lands, then October's run fires.
    await seedRecovery(db, "acct_on", 3_00);
    await driveMonthlyAudit(e, new Date("2026-10-01T09:00:00.000Z"), null);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("$5.00");
    expect(bodies[1]).toContain("$8.00"); // cumulative
    expect(bodies[1]).toContain("up $3.00"); // the month's change
  });

  it("only BILLABLE attribution counts, so a stripe_baseline row is not claimed", async () => {
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });
    await db.insert(failedPayments).values({
      id: "fp_base",
      stripeEventId: "evt_base",
      stripeInvoiceId: "in_base",
      stripeCustomerId: "cus_base",
      customerEmail: "c@example.test",
      amountCents: 900,
      currency: "usd",
      declineCategory: "soft",
      status: "recovered",
      detectedAt: NOW,
      accountId: "acct_on",
    });
    await db.insert(recoveredPayments).values({
      id: "rp_base",
      failedPaymentId: "fp_base",
      recoveredAt: NOW,
      amountCents: 900,
      currency: "usd",
      recoveryMethod: "stripe",
      accountId: "acct_on",
      attributionKind: "stripe_baseline",
    });

    const { bodies, env: e } = collector();
    await driveMonthlyAudit(e, NOW, null);

    expect(bodies[0]).toContain("No recovered payments are attributed to Foxhound yet");
    expect(bodies[0]).not.toContain("$9.00");
  });
});

// ============================================================================
// 5. Failure rides Session 24's alert machinery
// ============================================================================

describe("(5): a failing account is retried, and never stops another", () => {

  it("an account switched off after it was queued is not audited", async () => {
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });
    const queued: unknown[] = [];
    const e = env(undefined, queued);
    const job = CRON_JOBS.find((j) => j.name === CRON_NAME)!;
    await runCronJob(e, job.name, job.handler);
    await db.update(accounts).set({ auditAutoRun: false }).where(eq(accounts.id, "acct_on"));

    await consume(e, queued);

    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
    expect(await db.select().from(auditRuns)).toHaveLength(0);
  });
});

// ============================================================================
// The run message an operator reads
// ============================================================================

describe("the run message says what the cron queued", () => {
  it("a zero-queue run says WHY it queued nothing", () => {
    // "0 queued" alone cannot distinguish nobody-opted-in from cron-is-broken.
    const message = describeMonthlyAuditRun({ eligible: 3, optedIn: 0, enqueued: 0 });
    expect(message).toContain("3 eligible");
    expect(message).toContain("0 opted in");
    expect(message).toContain("0 queued for audit");
  });
});

describe("the monthly audit email escapes what it interpolates (review of PR 146)", () => {
  // The summary is model-written and the advisory is built from Stripe data, so
  // neither may land in the merchant's inbox as markup. Since E24 the builder
  // hands Capsomer plain strings and Capsomer escapes them, once, as it renders;
  // so the assertion reads the rendered HTML part.
  const withAdvisory = (advisory: string) =>
    resultWith({
      cardUpdater: ok({
        eventsInWindow: 0,
        expiredCardDeclinesInWindow: 3,
        advisory,
        windowDays: 30,
      }),
    });
  const html = (over: Partial<EmailInput>) => {
    const { subject, blocks } = emailFor(over);
    return renderFoxhoundEmail({ subject, blocks, brandName: "Foxhound", to: "owner@merchant.test" }).html;
  };

  it("escapes once, never twice", () => {
    const out = html({ summary: "Fees & refunds", result: withAdvisory("A & B") });
    expect(out).toContain(">Fees &amp; refunds</td>");
    expect(out).toContain(">Card Updater: A &amp; B</td>");
    expect(out).not.toContain("&amp;amp;");
  });
});
