import type Stripe from "stripe";
import { afterEach, beforeEach, vi } from "vitest";

import { accounts, failedPayments, recoveredPayments, stripeConnections } from "~/db/schema";

import { blockText } from "./email-words";
import { createInMemoryDb, d1Over } from "./inmemory-db";

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

export const monthly = await import("~/lib/audit/monthly.server");
export const { buildMonthlyAuditEmail, compareTotals } = await import("~/lib/audit/monthly-email");
export const { driveMonthlyAudit } = await import("./monthly-audit-queue");
export const { renderFoxhoundEmail } = await import("~/lib/email/templates");
export const { handleQueueBatch } = await import("~/lib/queue/consumer");
export const { cronRunId } = await import("~/lib/admin/crons");
export const { CRON_JOBS } = await import("~/lib/cron/registry");

// Spelled out rather than imported, so this file says what the deployed queue is
// called independently of the constant it checks.
export const AUDIT_QUEUE = "foxhound-audit";
export const CRON_NAME = "monthly-audit";
export const NOW = new Date("2026-09-01T09:00:00.000Z");
export const PERIOD = "2026-08";
export const BASE_URL = "https://foxhoundapp.test";
export const OCTOBER = new Date("2026-10-01T09:00:00.000Z");
export const DAY_SECONDS = 86_400;

export type TestDb = ReturnType<typeof createInMemoryDb>["db"];

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

export function throwingList(message: string): AsyncIterable<never> {
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

export function setup(stripeOver: Record<string, unknown> = {}) {
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
export async function seedAccount(
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
export async function seedRecovery(
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

export const monthMessage = (accountId: string) => ({
  accountId,
  periodMonth: PERIOD,
  cronRunId: null,
});

// The email body

export type EmailInput = Parameters<typeof buildMonthlyAuditEmail>[0];
export type EmailResult = EmailInput["result"];

export const ok = <T>(data: T) => ({ ok: true as const, data });
/** A scope whose Stripe read FAILED, in the engine's own shape. */
export const unread = (reason: string) => ({ ok: false as const, reason });

export const resultWith = (over: Partial<EmailResult> = {}): EmailResult =>
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

export const emailFor = (over: Partial<EmailInput> = {}) => {
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
