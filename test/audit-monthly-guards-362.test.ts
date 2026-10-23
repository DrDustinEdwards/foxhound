
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";


import { createInMemoryDb } from "./helpers/inmemory-db";

// PHASE (g)'S OWN GUARDS: the things the merge had to make true ABOUT THE REPO,
// as opposed to about one cron run. The behavioural suite is
// test/audit-monthly-362.test.ts; this file holds the derived sweeps and the
// pinned absences, which are the two kinds of assertion that go stale silently.
//
// THE ONE THAT MATTERS MOST IS PLANT 1. 362 ruling 3 exists because Foxhound had
// grown a SECOND monthly email off the same toggle without anyone noticing until
// a walk went looking. A plant naming the two known modules would not have caught
// that and would not catch the next one, so this derives the property from the
// toggle itself: whatever gates on `audit_auto_run` and also sends is the set,
// and the set has exactly one member.




// ============================================================================
// The cron's own no-write proof, against the real schema
// ============================================================================

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
const { accounts, stripeConnections } = await import("~/db/schema");

const NOW = new Date("2026-09-01T09:00:00.000Z");

describe("PLANT 5: a real run leaves no money row behind", () => {
  it("audits, stores and mails without touching outcomes or billing", async () => {
    // The source pin above says the names are absent; this says the TABLES are
    // untouched after a run that really happened, against the committed schema.
    const { sqlite, db } = createInMemoryDb();
    harness.db = db;
    harness.stripe = {
      invoices: {
        list: () => ({
          async *[Symbol.asyncIterator]() {
            yield { amount_due: 4200, currency: "usd", status: "uncollectible" } as unknown as Stripe.Invoice;
          },
        }),
      },
      subscriptions: { list: () => ({ async *[Symbol.asyncIterator]() {} }) },
      disputes: { list: () => ({ async *[Symbol.asyncIterator]() {} }) },
      events: { list: () => ({ async *[Symbol.asyncIterator]() {} }) },
    } as unknown as Stripe;

    await db.insert(accounts).values({
      id: "acct_on",
      name: "acct_on",
      notificationEmail: "owner@merchant.test",
      auditAutoRun: true,
      createdAt: NOW,
    });
    await db.insert(stripeConnections).values({
      id: "sc_on",
      accountId: "acct_on",
      stripeUserId: "acct_stripe_on",
      stripeAccessToken: "enc",
      isPrimary: true,
      connectedAt: NOW,
      createdAt: NOW,
    });

    const delivered: { to: string }[] = [];
    const env = {
      DB: {},
      EMAIL: {
        send: async (m: { to: string }) => {
          delivered.push(m);
          return { id: "m" };
        },
      },
      BETTER_AUTH_URL: "https://foxhoundapp.test",
    } as unknown as Env;

    const result = await driveMonthlyAudit(env, NOW, null);
    expect(result.sent).toBe(1);
    // AND THE MESSAGE ACTUALLY LEFT. `result.sent` is a counter the run
    // increments; asserting it alone would pass against a run that counted a
    // send it never made, which is exactly what the arm-2 mutation produced.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ to: "owner@merchant.test" });

    const count = (t: string) =>
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count("outcomes")).toBe(0);
    expect(count("billing_line_items")).toBe(0);
    expect(count("recovered_payments")).toBe(0);
    // What it DID write: one audit run and one month claim.
    expect(count("audit_runs")).toBe(1);
    expect(count("audit_digest_runs")).toBe(1);
  });
});
