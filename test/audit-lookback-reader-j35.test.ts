import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { accounts, auditRuns, stripeConnections } from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J35, row S30, DO step 3 and RULES.md 3.18: the lookback
// control on /settings/audit has a reader, and the reader is the monthly audit
// cron's content scope. Before this file nothing proved it: every run in
// audit-monthly-362.test.ts seeds a NULL lookback, so a cron that always used
// 90 would pass the whole suite.
//
// This drives the REAL monthly audit (cron half, then the consumer's per-account
// half, through driveMonthlyAudit) with getConnectedStripe as the only seam
// and reads what the merchant's setting did: the window the failed-invoice read
// asked Stripe for, and the lookback stored on the run the email links to.

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

const { driveMonthlyAudit } = await import("./helpers/monthly-audit-queue");

const NOW = new Date("2026-09-01T09:00:00.000Z");
const DAY_SECONDS = 86_400;

type TestDb = ReturnType<typeof createInMemoryDb>["db"];

function env(): Env {
  const stub = { acquire: async () => true, release: async () => {} };
  return {
    DB: {},
    EMAIL: { send: async () => ({ id: "m" }) },
    BETTER_AUTH_URL: "https://foxhoundapp.test",
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

/** A Stripe stand-in that records what the uncollectible-invoice read asked for. */
function recordingStripe() {
  const invoiceParams: Array<Record<string, unknown>> = [];
  const stripe = {
    invoices: {
      list: (params: Record<string, unknown>) => {
        invoiceParams.push(params);
        return fakeList([]);
      },
    },
    subscriptions: { list: () => fakeList([]) },
    disputes: { list: () => fakeList([]) },
    events: { list: () => fakeList([]) },
  } as unknown as Stripe;
  return { stripe, invoiceParams };
}

async function seed(db: TestDb, id: string, row: Record<string, unknown>) {
  await db.insert(accounts).values({
    id,
    name: id,
    notificationEmail: `${id}@merchant.test`,
    createdAt: NOW,
    auditAutoRun: true,
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

async function runWith(lookback: number | null) {
  const { db } = createInMemoryDb();
  harness.db = db;
  const { stripe, invoiceParams } = recordingStripe();
  harness.stripe = stripe;
  await seed(db, "acct_j35", { auditLookbackDays: lookback });

  const result = await driveMonthlyAudit(env(), NOW, null);
  const runs = await db.select().from(auditRuns);
  const uncollectible = invoiceParams.find((p) => p.status === "uncollectible");
  const gte = (uncollectible?.created as { gte?: number } | undefined)?.gte;
  return { result, runs, gte };
}

const windowStart = (days: number) => Math.floor(NOW.getTime() / 1000) - days * DAY_SECONDS;

describe("J35: the lookback a merchant sets is the window the monthly audit reads", () => {
  for (const days of [30, 60, 180]) {
    it(`a stored ${days}-day lookback asks Stripe for ${days} days and stores ${days} on the run`, async () => {
      const { result, runs, gte } = await runWith(days);
      expect(result.ran).toBe(1);
      expect(gte).toBe(windowStart(days));
      expect(runs).toHaveLength(1);
      expect(runs[0].lookbackDays).toBe(days);
    });
  }
});
