import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  auditDigestRuns,
  auditRuns,
  cronAlerts,
  cronRunHistory,
  failedPayments,
  recoveredPayments,
  stripeConnections,
} from "~/db/schema";
import { findStaleCrons } from "~/lib/cron/alerts.server";
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
// mapping. All of it is here, driving `runMonthlyAudit`. What died was the
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

const {
  auditPeriod,
  buildMonthlyAuditEmail,
  compareTotals,
  describeMonthlyAuditRun,
  MONTHLY_AUDIT_SUBJECT,
  runMonthlyAudit,
} = await import("~/lib/audit/monthly.server");
const { runCronJob } = await import("~/lib/cron/run");
const { CRON_JOBS, jobsForSchedule } = await import("~/lib/cron/registry");

const CRON_NAME = "monthly-audit";
const NOW = new Date("2026-09-01T09:00:00.000Z");
const PERIOD = "2026-08";
const BASE_URL = "https://foxhoundapp.test";

type TestDb = ReturnType<typeof createInMemoryDb>["db"];

function env(send: (m: unknown) => Promise<{ id: string }> = async () => ({ id: "m" })): Env {
  const stub = { acquire: async () => true, release: async () => {} };
  return {
    DB: {},
    EMAIL: { send },
    BETTER_AUTH_URL: BASE_URL,
    CRON_LOCK: { get: () => stub, idFromName: (n: string) => n },
  } as unknown as Env;
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

/** Collect every message body the run sent. */
function collector() {
  const bodies: string[] = [];
  const to: string[] = [];
  const e = env(async (m) => {
    bodies.push((m as { html?: string }).html ?? "");
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
    failedInvoices: ok({ count: 2, totalCents: 4200, byCategory: {} }),
    expiringCards: ok({ count: 1, mrrAtRiskCents: 1500, expiresByMonth: {} }),
    pastDueSubscriptions: ok({ count: 0, totalCents: 0 }),
    cardUpdater: ok({
      eventsInWindow: 0,
      expiredCardDeclinesInWindow: 0,
      advisory: null,
      windowDays: 30,
    }),
    disputes: ok({
      open: { count: 1, totalCents: 9900 },
      acceptedWithoutFighting: { count: 0, totalCents: 0 },
      historical: { won: 3, lost: 1 },
    }),
    health: ok({
      mrrCents: 100_000,
      arrCents: 1_200_000,
      activeSubscriptionsCount: 42,
      voluntaryChurnRateBps: 210,
      involuntaryChurnRateBps: 90,
    }),
    meta: { stripeAccountId: "acct_x", lookbackDays: 90, currency: "usd", ranAt: NOW },
    ...over,
  }) as EmailResult;

const emailFor = (over: Partial<EmailInput> = {}) =>
  buildMonthlyAuditEmail({
    result: resultWith(),
    summary: "One. Two. Three.",
    runId: "run_123",
    baseUrl: BASE_URL,
    comparisons: [{ currency: "usd", cents: 12_40, changeCents: 3_10 }],
    periodMonth: PERIOD,
    ...over,
  });

// ============================================================================
// Pure decisions
// ============================================================================

describe("the period a run covers", () => {
  it("a run on the 1st covers the month that just ended", () => {
    expect(auditPeriod(NOW)).toBe(PERIOD);
  });

  it("January's run covers the PREVIOUS YEAR's December", () => {
    expect(auditPeriod(new Date("2027-01-01T09:00:00.000Z"))).toBe("2026-12");
  });

  it("the period string is zero-padded, so it sorts as a string", () => {
    expect(auditPeriod(new Date("2026-11-01T09:00:00.000Z"))).toBe("2026-10");
  });
});

describe("the comparison is per currency and never summed across them", () => {
  it("a first run reports NO change rather than a change of zero", () => {
    expect(compareTotals([{ currency: "usd", cents: 500 }], null)).toEqual([
      { currency: "usd", cents: 500, changeCents: null },
    ]);
  });

  it("a later run reports the delta against the prior snapshot", () => {
    expect(compareTotals([{ currency: "usd", cents: 800 }], [{ currency: "usd", cents: 500 }])).toEqual([
      { currency: "usd", cents: 800, changeCents: 300 },
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

  it("a currency that DISAPPEARED still produces a row, as a fall to zero", () => {
    expect(compareTotals([], [{ currency: "gbp", cents: 400 }])).toEqual([
      { currency: "gbp", cents: 0, changeCents: -400 },
    ]);
  });
});

// ============================================================================
// The merged email body: legacy's strings, the absorbed line, the unread rule
// ============================================================================

describe("362 ruling 3: the ONE email carries BOTH halves", () => {
  it("THE SUBJECT IS LEGACY'S, with the one brand substitution", () => {
    // Legacy: `const subject = 'Your monthly Recova report'`.
    expect(MONTHLY_AUDIT_SUBJECT).toBe("Your monthly Foxhound report");
    expect(MONTHLY_AUDIT_SUBJECT).not.toContain("Recova");
    expect(emailFor().subject).toBe(`Your monthly Foxhound report: ${PERIOD}`);
  });

  it("carries the AUDIT half, at legacy's row labels", () => {
    const { bodyHtml } = emailFor();
    for (const label of [
      "Your Stripe health",
      "MRR",
      "ARR",
      "Active subs",
      "Failed payments detected",
      "Expiring cards",
      "Past-due subscriptions",
      "Voluntary churn",
      "Involuntary churn",
      "Open disputes",
      "Disputes accepted without response",
      "Dispute win rate",
      "View full audit",
    ]) {
      expect(bodyHtml, `${label} missing`).toContain(label);
    }
    expect(bodyHtml).toContain("$1,000"); // MRR
    expect(bodyHtml).toContain("42"); // active subs
    expect(bodyHtml).toContain("2.1%"); // voluntary churn, legacy's one decimal
    expect(bodyHtml).toContain("75% (3W / 1L)"); // legacy's win-rate format
  });

  it("AND THE ABSORBED DIGEST LINE, which is what the merge is", () => {
    // 362 ruling 3: the ported audit email absorbs computeFoxhoundAddsCents.
    // Its heading is legacy's, with the brand substitution.
    const { bodyHtml } = emailFor();
    expect(bodyHtml).toContain("What Foxhound did this month");
    expect(bodyHtml).toContain("$12.40");
    expect(bodyHtml).toContain("up $3.10");
  });

  it("a FALL reads as down, not as a negative amount", () => {
    const { bodyHtml } = emailFor({ comparisons: [{ currency: "usd", cents: 100, changeCents: -500 }] });
    expect(bodyHtml).toContain("down $5.00");
    expect(bodyHtml).not.toContain("-$5.00");
  });

  it("no attributed recovery yet says so, rather than printing a zero", () => {
    const { bodyHtml } = emailFor({ comparisons: [] });
    expect(bodyHtml).toContain("No recovered payments are attributed to Foxhound yet");
  });

  it("THE LINK IS THE STORED RUN, which only that account can open", () => {
    // 365 binding 1: no stored run was ever publicly readable, on either side.
    // The email carries a per-run URL and the page pins the account in its
    // predicate, so a forwarded link refuses rather than leaking.
    expect(emailFor().bodyHtml).toContain(`${BASE_URL}/audit/runs/run_123`);
  });

  it("A FAILED SCOPE READS AS COULD-NOT-BE-READ, never as a zero", () => {
    // 362 RULING 2 REACHES THE EMAIL, which is the last layer it had to survive.
    // The engine gave a scope its status, (d) stored it as the NULL, (e)
    // rendered it as a sentence, and an email that coalesced it back to 0 would
    // tell a merchant they have no open disputes on the strength of a Stripe
    // call that failed. Legacy cannot make this mistake in its own email only
    // because its engine already zeroed the scope one step earlier, which is the
    // same lie with better manners.
    const { bodyHtml } = emailFor({
      result: resultWith({ disputes: unread("Could not read disputes from Stripe: 500") }),
    });

    expect(bodyHtml).toContain(`<strong>Open disputes:</strong> ${SCOPE_UNREAD}`);
    expect(bodyHtml).toContain(
      `<strong>Disputes accepted without response:</strong> ${SCOPE_UNREAD}`,
    );
    // A zero would be indistinguishable from a merchant with no open disputes.
    expect(bodyHtml).not.toContain("<strong>Open disputes:</strong> 0");
    // The win rate has no honest value without the scope, so its row is the
    // sentence too rather than being silently dropped.
    expect(bodyHtml).toContain(`<strong>Dispute win rate:</strong> ${SCOPE_UNREAD}`);
    // The scopes that DID read are unaffected, so this is per scope and not a
    // whole-email bail-out.
    expect(bodyHtml).toContain("<strong>MRR:</strong> $1,000");
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
      const { bodyHtml } = emailFor({ result: resultWith(over) });
      for (const label of labels) {
        expect(bodyHtml, `${label} did not say it was unread`).toContain(
          `<strong>${label}:</strong> ${SCOPE_UNREAD}`,
        );
      }
    }
  });

  it("names the setting that turns it off, since the merchant opted in", () => {
    expect(emailFor().bodyHtml).toContain("audit settings");
  });

  it("NEVER names the AI vendor", () => {
    const { bodyHtml } = emailFor();
    for (const banned of ["Claude", "Anthropic", "GPT", "LLM", "written by AI"]) {
      expect(bodyHtml).not.toContain(banned);
    }
  });

  it("AND CARRIES NO EM DASH, which legacy's own row separators are", () => {
    // Legacy writes `${count} &mdash; ${amount}` on five rows, which renders as
    // an em dash in the merchant's inbox. Not ported.
    const { bodyHtml } = emailFor();
    expect(bodyHtml).not.toContain("&mdash;");
    expect(bodyHtml).not.toContain(String.fromCharCode(0x2014));
    expect(bodyHtml).not.toContain(String.fromCharCode(0x2013));
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

  it("THE REGISTERED HANDLER RUNS through runCronJob and records history", async () => {
    // Not "the array contains a name": the registry's own handler is pulled out
    // and driven through the real gate/lock/history path.
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    const job = CRON_JOBS.find((j) => j.name === CRON_NAME)!;
    const outcome = await runCronJob(env(), job.name, job.handler);

    expect(outcome.status).toBe("success");
    const runs = await db.select().from(cronRunHistory);
    expect(runs).toHaveLength(1);
    expect(runs[0].cronName).toBe(CRON_NAME);
    expect(runs[0].rowsProcessed).toBe(1);

    // The claim row names the run that produced it.
    const claims = await db.select().from(auditDigestRuns);
    expect(claims).toHaveLength(1);
    expect(claims[0].cronRunId).toBe(runs[0].id);
    expect(claims[0].status).toBe("sent");
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
    await runMonthlyAudit(e, NOW, null);

    expect(bodies[0]).toContain(`<strong>Open disputes:</strong> ${SCOPE_UNREAD}`);
    expect(bodies[0]).not.toContain("<strong>Open disputes:</strong> 0");
    // The stored row carries the same unknown, as a NULL rather than a zero.
    const stored = await db.select().from(auditRuns);
    expect(stored[0].openDisputesCount).toBeNull();
    // And the scopes that read are still numbers on both.
    expect(stored[0].failedInvoicesCents).toBe(4200);
    // Legacy's zero-fraction formatting on a diagnostic figure.
    expect(bodies[0]).toContain("$42");
  });

  it("AND THE AUDIT ITSELF IS PERSISTED, which the digest never did", async () => {
    // Phase (d)'s writer, reached from the cron. The digest read Foxhound's own
    // rows and wrote no audit_runs row at all.
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    await runMonthlyAudit(env(), NOW, null);

    const stored = await db.select().from(auditRuns);
    expect(stored).toHaveLength(1);
    expect(stored[0].accountId).toBe("acct_on");
    expect(stored[0].failedInvoicesCents).toBe(4200);
    expect(stored[0].openDisputesCents).toBe(9900);
  });
});

// ============================================================================
// 2. The opt-in gate, THROUGH the shared predicate
// ============================================================================

describe("(2): the toggle is read through the SHARED predicate", () => {
  it("a NULL account is SKIPPED, which is the halt Session 25 called", async () => {
    const db = fresh();
    await seedAccount(db, "acct_null", { auditAutoRun: null });

    const result = await runMonthlyAudit(env(), NOW, null);

    expect(result.eligible).toBe(1); // it WAS enumerated
    expect(result.optedIn).toBe(0); // and the predicate refused it
    expect(result.sent).toBe(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
    expect(await db.select().from(auditRuns)).toHaveLength(0);
  });

  it("an explicitly FALSE account is skipped the same way", async () => {
    const db = fresh();
    await seedAccount(db, "acct_off", { auditAutoRun: false });

    const result = await runMonthlyAudit(env(), NOW, null);

    expect(result.eligible).toBe(1);
    expect(result.optedIn).toBe(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(0);
  });

  it("a TRUE account sends, so the skips above are the predicate and not inertia", async () => {
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    const { to, env: e } = collector();
    const result = await runMonthlyAudit(e, NOW, null);

    expect(result.optedIn).toBe(1);
    expect(result.ran).toBe(1);
    expect(result.sent).toBe(1);
    expect(to).toEqual(["acct_on@merchant.test"]);
  });

  it("THE GATE IS NOT IN SQL: an opted-out account is still ENUMERATED", async () => {
    // 316's design note, kept in force by the merge. If the toggle moved into
    // the WHERE clause (which is what legacy writes), the page and the cron
    // could drift apart on what NULL means with no test noticing. `eligible`
    // counts rows the QUERY returned; `optedIn` counts what the shared predicate
    // allowed. They must differ here.
    const db = fresh();
    await seedAccount(db, "a_on", { auditAutoRun: true });
    await seedAccount(db, "a_null", { auditAutoRun: null });
    await seedAccount(db, "a_off", { auditAutoRun: false });

    const result = await runMonthlyAudit(env(), NOW, null);

    expect(result.eligible).toBe(3);
    expect(result.optedIn).toBe(1);
  });
});

// ============================================================================
// 3. Account states, matching the sibling crons
// ============================================================================

describe("(3): the account states every other per-account cron respects", () => {
  it("a PROCESSING-PAUSED account is skipped even with the toggle on", async () => {
    const db = fresh();
    await seedAccount(db, "acct_paused", { auditAutoRun: true, processingPaused: true });

    const result = await runMonthlyAudit(env(), NOW, null);

    expect(result.eligible).toBe(0);
    expect(result.sent).toBe(0);
  });

  it("a CANCELLED account is skipped even with the toggle on", async () => {
    const db = fresh();
    await seedAccount(db, "acct_cancelled", { auditAutoRun: true, cancelledAt: NOW });

    expect((await runMonthlyAudit(env(), NOW, null)).eligible).toBe(0);
  });

  it("A DEMO ACCOUNT IS REFUSED, toggle on, connection live, everything else right", async () => {
    // The demo firewall is `accountProcessingEligibleCondition()`'s
    // `id NOT LIKE 'demo\\_%'`, unchanged by this phase. Legacy needs a SECOND
    // filter on the Stripe id because the account id is not its firewall;
    // Foxhound's sits one level up and catches this before a token is decrypted.
    const db = fresh();
    await seedAccount(db, "demo_teamflow", { auditAutoRun: true }, { stripeUserId: "acct_demo_teamflow" });

    const { to, env: e } = collector();
    const result = await runMonthlyAudit(e, NOW, null);

    expect(result.eligible).toBe(0);
    expect(to).toEqual([]);
    expect(await db.select().from(auditRuns)).toHaveLength(0);
  });

  it("BILLING-EXEMPT is deliberately NOT a gate: the audit is free", async () => {
    const db = fresh();
    await seedAccount(db, "acct_exempt", { auditAutoRun: true, billingExempt: true });

    expect((await runMonthlyAudit(env(), NOW, null)).sent).toBe(1);
  });

  it("an account with NO notification email is audited but not mailed", async () => {
    // 339: notification_email is the only recipient. The run still happens and
    // is still readable in history, which is the merge's one behaviour change
    // over the digest here.
    const db = fresh();
    await seedAccount(db, "acct_noemail", { auditAutoRun: true, notificationEmail: null });

    const { to, env: e } = collector();
    const result = await runMonthlyAudit(e, NOW, null);

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
    const result = await runMonthlyAudit(e, NOW, null);

    expect(result.skippedNoConnection).toBe(1);
    expect(result.ran).toBe(0);
    expect(to).toEqual([]);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("no_connection");
  });

  it("A DISCONNECTED connection is not a live one", async () => {
    const db = fresh();
    await seedAccount(db, "acct_gone", { auditAutoRun: true });
    await db
      .update(stripeConnections)
      .set({ disconnectedAt: NOW })
      .where(eq(stripeConnections.id, "sc_acct_gone"));

    expect((await runMonthlyAudit(env(), NOW, null)).skippedNoConnection).toBe(1);
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
    const first = await runMonthlyAudit(e, NOW, null);
    const second = await runMonthlyAudit(e, NOW, null);

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
    // concurrent run would have. Nothing in runMonthlyAudit has seen it.
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
    const result = await runMonthlyAudit(e, NOW, null);

    expect(result.optedIn).toBe(1); // it got as far as the claim
    expect(result.skippedDuplicate).toBe(1); // and the index refused it
    expect(bodies).toHaveLength(0);
    expect(await db.select().from(auditDigestRuns)).toHaveLength(1);
  });

  it("the SAME account in a DIFFERENT month is a different slot", async () => {
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    await runMonthlyAudit(env(), NOW, null);
    const october = await runMonthlyAudit(env(), new Date("2026-10-01T09:00:00.000Z"), null);

    expect(october.sent).toBe(1);
    const rows = await db.select().from(auditDigestRuns);
    expect(rows.map((r) => r.periodMonth).sort()).toEqual(["2026-08", "2026-09"]);
  });

  it("TWO accounts in the same month do not collide with each other", async () => {
    const db = fresh();
    await seedAccount(db, "a_one", { auditAutoRun: true });
    await seedAccount(db, "a_two", { auditAutoRun: true });

    expect((await runMonthlyAudit(env(), NOW, null)).sent).toBe(2);
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

    await runMonthlyAudit(e, NOW, null);
    // A further recovery lands, then October's run fires.
    await seedRecovery(db, "acct_on", 3_00);
    await runMonthlyAudit(e, new Date("2026-10-01T09:00:00.000Z"), null);

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
    await runMonthlyAudit(e, NOW, null);

    expect(bodies[0]).toContain("No recovered payments are attributed to Foxhound yet");
    expect(bodies[0]).not.toContain("$9.00");
  });
});

// ============================================================================
// 5. Failure rides Session 24's alert machinery
// ============================================================================

describe("(5): a failing run alerts through Session 24's path", () => {
  it("A BROKEN SEND fails the run and writes a cron_alerts row", async () => {
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    const job = CRON_JOBS.find((j) => j.name === CRON_NAME)!;
    const outcome = await runCronJob(
      env(async () => {
        throw new Error("email down");
      }),
      job.name,
      job.handler,
    );

    expect(outcome.status).toBe("failed");
    // The alert is the machinery from 313/314, not a new one built here.
    expect(outcome.alert).toEqual({ sent: false, reason: "send_failed", error: "email down" });
    const alerts = await db.select().from(cronAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].cronName).toBe(CRON_NAME);
    expect(alerts[0].kind).toBe("failure");
  });

  it("ONE MERCHANT'S FAILURE does not stop another merchant's report", async () => {
    const db = fresh();
    await seedAccount(db, "a_bad", { auditAutoRun: true, notificationEmail: "bad@merchant.test" });
    await seedAccount(db, "a_good", { auditAutoRun: true, notificationEmail: "good@merchant.test" });

    const delivered: string[] = [];
    await expect(
      runMonthlyAudit(
        env(async (m) => {
          const to = (m as { to: string }).to;
          if (to === "bad@merchant.test") throw new Error("mailbox full");
          delivered.push(to);
          return { id: "m" };
        }),
        NOW,
        null,
      ),
    ).rejects.toThrow("mailbox full");

    // The good merchant was still served, and the bad one left a trace.
    expect(delivered).toEqual(["good@merchant.test"]);
    const rows = await db.select().from(auditDigestRuns);
    expect(rows.find((r) => r.accountId === "a_bad")!.status).toBe("failed");
    expect(rows.find((r) => r.accountId === "a_bad")!.error).toBe("mailbox full");
    expect(rows.find((r) => r.accountId === "a_good")!.status).toBe("sent");
  });

  it("A FAILED MONTH IS NOT RETRIED next run: the claim stands", async () => {
    // Retry-from-DLQ is out of scope. The row is the trace, and the month is
    // burned rather than silently re-sent.
    const db = fresh();
    await seedAccount(db, "acct_on", { auditAutoRun: true });

    await expect(
      runMonthlyAudit(
        env(async () => {
          throw new Error("email down");
        }),
        NOW,
        null,
      ),
    ).rejects.toThrow();

    const retry = await runMonthlyAudit(env(), NOW, null);
    expect(retry.sent).toBe(0);
    expect(retry.skippedDuplicate).toBe(1);
  });
});

// ============================================================================
// 6. cron-health can judge it (314's unmappable posture)
// ============================================================================

describe("(6): cron-health sees the NEW schedule as MAPPABLE", () => {
  it("the merged job's schedule resolves to a period, so staleness is judgeable", () => {
    // THE TRAP A NEW CRON EXPRESSION SETS. `SCHEDULE_PERIOD_MS` is keyed by the
    // expression string, so a job on an unmapped one reports `unknown_schedule`,
    // which is a blind spot rather than an alert. Moving to legacy's 09:00 meant
    // mapping it, and this is what proves the mapping landed.
    const job = CRON_JOBS.find((j) => j.name === CRON_NAME)!;
    const findings = findStaleCrons([job], new Map([[job.name, new Date(NOW)]]), NOW);
    expect(findings).toEqual([]);

    const overdue = findStaleCrons(
      [job],
      new Map([[job.name, new Date("2026-05-01T09:00:00.000Z")]]),
      NOW,
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0].reason).toBe("overdue");
    expect(overdue[0].reason).not.toBe("unknown_schedule");
  });

  it("a NEVER-RUN job is reported, which is the billing-monthly class", () => {
    const job = CRON_JOBS.find((j) => j.name === CRON_NAME)!;
    expect(findStaleCrons([job], new Map([[job.name, null]]), NOW)[0].reason).toBe("never_run");
  });
});

// ============================================================================
// The run message an operator reads
// ============================================================================

describe("the run message distinguishes the outcomes", () => {
  const base = {
    eligible: 3,
    optedIn: 0,
    ran: 0,
    sent: 0,
    skippedDuplicate: 0,
    skippedNoConnection: 0,
    skippedNoRecipient: 0,
    failed: 0,
    firstError: null,
  };

  it("a zero-send run says WHY it sent nothing", () => {
    // "0 sent" alone cannot distinguish nobody-opted-in from cron-is-broken.
    const message = describeMonthlyAuditRun(base);
    expect(message).toContain("3 eligible");
    expect(message).toContain("0 opted in");
  });

  it("a deduped run is visibly different from an empty one", () => {
    const message = describeMonthlyAuditRun({ ...base, eligible: 1, optedIn: 1, skippedDuplicate: 1 });
    expect(message).toContain("1 already sent this month");
  });

  it("and a connection-less run is visibly different from both", () => {
    const message = describeMonthlyAuditRun({ ...base, eligible: 1, optedIn: 1, skippedNoConnection: 1 });
    expect(message).toContain("1 without a live connection");
  });
});

