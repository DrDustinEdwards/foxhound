import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { accounts, auditDigestRuns, auditRuns, emailSends, emailSuppressions, stripeConnections } from "~/db/schema";
import { SCOPE_UNREAD } from "~/lib/audit/render";
import { EMAIL_AUTH_SENDER_ADDRESS, EMAIL_FROM_ADDRESS } from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J96, parity row E24: the monthly audit report. Recova's buildAuditEmailBody
// (app/api/cron/run-scheduled-audits/route.ts, blob be1ed2ca, lines 169 to 310)
// and its send (lines 384 to 389, from FROM_HELLO through wrapEmailHtml with no
// unsubscribe token) are the spec for what the mail says, carries and when it
// sends. Its layout is Capsomer's email component (Q3). Every send assertion
// reads the message as it reaches env.EMAIL.send.

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

const monthly = await import("~/lib/audit/monthly.server");
const { buildMonthlyAuditEmail, processMonthlyAuditMessage } = monthly;
const { driveMonthlyAudit } = await import("./helpers/monthly-audit-queue");

const NOW = new Date("2026-09-01T09:00:00.000Z");
const PERIOD = "2026-08";
const BASE = "https://foxhoundapp.test";

interface Sent {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

function envWith(send: (m: Sent) => Promise<{ id: string }> = async () => ({ id: "m" })): Env {
  return {
    DB: {},
    EMAIL: { send },
    BETTER_AUTH_URL: BASE,
    CRON_LOCK: {
      get: () => ({ acquire: async () => true, release: async () => {} }),
      idFromName: (n: string) => n,
    },
  } as unknown as Env;
}

function collector() {
  const sent: Sent[] = [];
  return { sent, env: envWith(async (m) => (sent.push(m), { id: "m" })) };
}

function fakeList<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

function fresh() {
  const { db } = createInMemoryDb();
  harness.db = db;
  harness.stripe = {
    invoices: {
      list: () =>
        fakeList([
          {
            amount_due: 4200,
            currency: "usd",
            status: "uncollectible",
            last_finalization_error: { decline_code: "insufficient_funds" },
          },
        ]),
    },
    subscriptions: { list: () => fakeList([]) },
    disputes: { list: () => fakeList([{ amount: 9900, currency: "usd", status: "needs_response" }]) },
    events: { list: () => fakeList([]) },
  } as unknown as Stripe;
  return db;
}

async function seed(db: ReturnType<typeof fresh>, id: string, row: Record<string, unknown> = {}) {
  await db.insert(accounts).values({
    id,
    name: id,
    notificationEmail: `${id}@merchant.test`,
    auditAutoRun: true,
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
    // A merchant's own reply-to is for its customers' mail, never this one.
    replyToEmail: "billing@merchant.test",
  });
}

type EmailInput = Parameters<typeof buildMonthlyAuditEmail>[0];
type EmailResult = EmailInput["result"];
const ok = <T,>(data: T) => ({ ok: true as const, data });
const unread = (reason: string) => ({ ok: false as const, reason });

const resultWith = (over: Partial<EmailResult> = {}): EmailResult =>
  ({
    failedInvoices: ok({ count: 2, totalCents: 4200, byCategory: {} }),
    expiringCards: ok({ count: 1, mrrAtRiskCents: 1500, expiresByMonth: {} }),
    pastDueSubscriptions: ok({ count: 0, totalCents: 0 }),
    cardUpdater: ok({ eventsInWindow: 0, expiredCardDeclinesInWindow: 0, advisory: null, windowDays: 30 }),
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
    baseUrl: BASE,
    comparisons: [{ currency: "usd", cents: 12_40, changeCents: 3_10 }],
    ...over,
  });

const texts = (blocks: { type: string; text?: string; label?: string }[]) =>
  blocks.map((b) => b.text ?? b.label ?? "");

// ============================================================================

describe("E24 says what Recova's says", () => {
  it("the subject is Recova's, Foxhound-branded, with no month", () => {
    // Recova: `const subject = 'Your monthly Recova report'`.
    expect(emailFor().subject).toBe("Your monthly Foxhound report");
  });

  it("every block, in Recova's order and words, on Capsomer's blocks", () => {
    expect(emailFor().blocks).toEqual([
      { type: "paragraph", text: "One. Two. Three." },
      { type: "fine", text: "What Foxhound did this month" },
      { type: "paragraph", text: "$12.40 recovered to date (USD), up $3.10 since last month." },
      { type: "fine", text: "Your Stripe health" },
      { type: "paragraph", text: "MRR: $1,000" },
      { type: "paragraph", text: "ARR: $12,000" },
      { type: "paragraph", text: "Active subs: 42" },
      { type: "paragraph", text: "Failed payments detected: 2, $42" },
      { type: "paragraph", text: "Expiring cards: 1, $15 MRR at risk" },
      { type: "paragraph", text: "Past-due subscriptions: 0, $0" },
      { type: "paragraph", text: "Voluntary churn: 2.1%" },
      { type: "paragraph", text: "Involuntary churn: 0.9%" },
      { type: "paragraph", text: "Open disputes: 1, $99" },
      { type: "paragraph", text: "Dispute win rate: 75% (3W / 1L)" },
      { type: "button", label: "View full audit", url: `${BASE}/audit/results/run_123` },
    ]);
  });

  it("Open disputes shows only when the count is above zero, as Recova's does", () => {
    const none = emailFor({
      result: resultWith({
        disputes: ok({
          open: { count: 0, totalCents: 0 },
          acceptedWithoutFighting: { count: 0, totalCents: 0 },
          historical: { won: 0, lost: 0 },
        }),
      }),
    });
    const lines = texts(none.blocks);
    expect(lines.some((t) => t.startsWith("Open disputes"))).toBe(false);
    // And with no decided disputes there is no win rate, as in Recova.
    expect(lines.some((t) => t.startsWith("Dispute win rate"))).toBe(false);
  });

  it("Disputes accepted without response shows only when above zero, after Open disputes", () => {
    const lines = texts(
      emailFor({
        result: resultWith({
          disputes: ok({
            open: { count: 1, totalCents: 9900 },
            acceptedWithoutFighting: { count: 2, totalCents: 5000 },
            historical: { won: 3, lost: 1 },
          }),
        }),
      }).blocks,
    );
    const open = lines.indexOf("Open disputes: 1, $99");
    expect(open).toBeGreaterThan(-1);
    expect(lines[open + 1]).toBe("Disputes accepted without response: 2");
    expect(texts(emailFor().blocks).some((t) => t.startsWith("Disputes accepted"))).toBe(false);
  });

  it("the Card Updater line follows the win rate when an advisory exists", () => {
    const lines = texts(
      emailFor({
        result: resultWith({
          cardUpdater: ok({
            eventsInWindow: 0,
            expiredCardDeclinesInWindow: 3,
            advisory: "3 expired-card declines and no Card Updater events.",
            windowDays: 30,
          }),
        }),
      }).blocks,
    );
    const win = lines.indexOf("Dispute win rate: 75% (3W / 1L)");
    expect(lines[win + 1]).toBe("Card Updater: 3 expired-card declines and no Card Updater events.");
  });

  it("a disputes read that failed still says so, rather than hiding the rows (362 ruling 2)", () => {
    const lines = texts(emailFor({ result: resultWith({ disputes: unread("stripe 500") }) }).blocks);
    expect(lines).toContain(`Open disputes: ${SCOPE_UNREAD}`);
    expect(lines).toContain(`Disputes accepted without response: ${SCOPE_UNREAD}`);
    expect(lines).toContain(`Dispute win rate: ${SCOPE_UNREAD}`);
  });

  it("carries no sentence Recova's does not: the old opt-out line is gone", () => {
    const lines = texts(emailFor().blocks).join("\n");
    expect(lines).not.toContain("audit settings");
    expect(lines).not.toContain("You are receiving this because");
  });

  it("the model-written summary and the advisory are plain strings, never markup", () => {
    const hostile = `<img src=x onerror="alert(1)">&'`;
    const { blocks } = emailFor({
      summary: hostile,
      result: resultWith({
        cardUpdater: ok({ eventsInWindow: 0, expiredCardDeclinesInWindow: 3, advisory: hostile, windowDays: 30 }),
      }),
    });
    expect(blocks[0]).toEqual({ type: "paragraph", text: hostile });
    expect(texts(blocks)).toContain(`Card Updater: ${hostile}`);
  });
});

// ============================================================================

describe("E24 carries what Recova's carries, and sends when Recova's does", () => {
  it("one mail per opted-in account, on the merchant path: From Foxhound, no Reply-To, Recova's footer", async () => {
    const db = fresh();
    await seed(db, "acct_on");
    const { sent, env } = collector();

    const result = await driveMonthlyAudit(env, NOW, null);

    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.to).toBe("acct_on@merchant.test");
    expect(m.from).toBe(`Foxhound <${EMAIL_FROM_ADDRESS}>`);
    expect(m.from).not.toContain(EMAIL_AUTH_SENDER_ADDRESS);
    expect(m.subject).toBe("Your monthly Foxhound report");
    expect(m.replyTo).toBeUndefined();
    // Merchant mail: no unsubscribe link, header or postal address (RULES.md 3.16).
    expect(m.headers).toBeUndefined();
    expect(m.text).not.toContain("Unsubscribe");
    // Recova's wrapEmailHtml footer with no unsubscribe token.
    expect(m.text).toContain("You're receiving this from Foxhound about a recent payment. © 2026");
    expect(m.text).toContain(`Manage email settings: ${BASE}/settings`);
    // Both parts, the one button a real link with visible text.
    const [run] = await db.select().from(auditRuns);
    expect(m.text).toContain(`View full audit:\n${BASE}/audit/results/${run.id}`);
    expect(m.html).toMatch(new RegExp(`<a class="e-btn" href="${BASE}/audit/results/${run.id}"[^>]*>View full audit</a>`));
    expect(m.html).toContain('<html lang="en">');
    expect(m.html).toContain("<title>Your monthly Foxhound report</title>");
  });

  it("logs the send under its own template, on the account", async () => {
    const db = fresh();
    await seed(db, "acct_on");
    await driveMonthlyAudit(collector().env, NOW, null);

    const rows = await db.select().from(emailSends);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountId: "acct_on", template: "monthly_audit", status: "sent" });
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("sent");
  });

  it("not when the toggle is off or NULL (Recova's audit_auto_run = true)", async () => {
    const db = fresh();
    await seed(db, "acct_off", { auditAutoRun: false });
    await seed(db, "acct_null", { auditAutoRun: null });
    const { sent, env } = collector();

    await driveMonthlyAudit(env, NOW, null);

    expect(sent).toHaveLength(0);
  });

  it("not when the account has no notification address, as in Recova", async () => {
    const db = fresh();
    await seed(db, "acct_none", { notificationEmail: null });
    const { sent, env } = collector();

    expect((await driveMonthlyAudit(env, NOW, null)).skippedNoRecipient).toBe(1);
    expect(sent).toHaveLength(0);
  });
});

// ============================================================================

describe("a refused send returns its named outcome (RULES.md 3.16)", () => {
  it("a suppressed address is not mailed, and the month says suppressed", async () => {
    const db = fresh();
    await seed(db, "acct_on");
    await db.insert(emailSuppressions).values({
      id: "sup_1",
      email: "acct_on@merchant.test",
      token: "t",
      suppressedAt: NOW,
      reason: "bounce",
    });
    const { sent, env } = collector();

    const outcome = await monthly.auditAccountForMonth(env, { accountId: "acct_on", periodMonth: PERIOD, cronRunId: null }, NOW);

    expect(outcome.status).toBe("suppressed");
    expect(sent).toHaveLength(0);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("suppressed");
    // The audit itself still ran and is in history.
    expect(await db.select().from(auditRuns)).toHaveLength(1);
  });

  it("an account whose live sends are off still gets its report: Recova has no such switch", async () => {
    // Review round 1 of PR 160. live_sends_enabled defaults false and is on
    // only for the end-to-end test account (RULES.md 3.21), so holding this
    // mail behind it would silence every real merchant's report.
    const db = fresh();
    await seed(db, "acct_on", { liveSendsEnabled: false });
    const { sent, env } = collector();

    const outcome = await monthly.auditAccountForMonth(env, { accountId: "acct_on", periodMonth: PERIOD, cronRunId: null }, NOW);

    expect(outcome.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("sent");
  });

  it("a standing send claim for the month is already_sent: nothing is mailed again", async () => {
    // The month row failed after its email_sends claim was taken with no
    // error (the outcome is unknown), so the retry must not mail a second time.
    // The key is per account per MONTH, so a retry (new audit run id) finds it.
    const db = fresh();
    await seed(db, "acct_on");
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
    const { sent, env } = collector();

    const outcome = await monthly.auditAccountForMonth(env, { accountId: "acct_on", periodMonth: PERIOD, cronRunId: null }, NOW);

    expect(outcome.status).toBe("already_sent");
    expect(sent).toHaveLength(0);
    expect((await db.select().from(auditDigestRuns))[0].status).toBe("already_sent");
  });

  it("a provider failure is failed, with the provider's words, and is retried", async () => {
    const db = fresh();
    await seed(db, "acct_on");
    const env = envWith(async () => {
      throw new Error("mailbox full");
    });

    const outcome = await monthly.auditAccountForMonth(env, { accountId: "acct_on", periodMonth: PERIOD, cronRunId: null }, NOW);
    expect(outcome.status).toBe("failed");
    expect((outcome.error as Error).message).toBe("mailbox full");
    const [claim] = await db.select().from(auditDigestRuns);
    expect(claim).toMatchObject({ status: "failed", error: "mailbox full" });

    // The next delivery retakes the month and sends once.
    const { sent, env: ok2 } = collector();
    const action = await processMonthlyAuditMessage(ok2, { accountId: "acct_on", periodMonth: PERIOD, cronRunId: null }, 2, NOW);
    expect(action).toBe("ack");
    expect(sent).toHaveLength(1);
  });
});
