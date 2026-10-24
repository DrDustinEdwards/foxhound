import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The platform endpoint used to claim the event with a plain insert BEFORE
// dispatching, then swallow any dispatch failure into a 200. So a lost
// invoice.paid was lost permanently: marked processed, Stripe told everything
// was fine and never redelivering, and the platform webhook is itself the only
// reconciler for platform invoice status.
//
// These drive the real route action, so the assertions are the same shape
// against the old and new code: HTTP status plus committed rows.
//
// The claim now rides the SAME atomic money batch as the status update
// (gotcha 32's folded-claim pattern), which is what makes "the dispatch failed,
// so nothing was claimed" true rather than aspirational.

const ACCOUNT_ID = "acc_platform";
const BILLING_INVOICE_ID = "binv_1";
const RECEIVED_AT = new Date("2026-08-01T05:00:00.000Z");

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  event: null as unknown,
  signatureValid: true,
  failNextCommit: false,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { build: (db: unknown) => unknown[] },
  ): Promise<{ applied: boolean }> => {
    const sqlite = harness.sqlite as { exec: (s: string) => void };
    const batch = write.build(harness.db);
    // Model the money DO honestly: the whole batch commits atomically or not at
    // all. Without the transaction the claim would survive a failed update and
    // this test would prove nothing.
    sqlite.exec("BEGIN");
    try {
      for (const stmt of batch) await (stmt as Promise<unknown>);
      if (harness.failNextCommit) throw new Error("d1 batch failed");
      sqlite.exec("COMMIT");
      return { applied: true };
    } catch (err) {
      sqlite.exec("ROLLBACK");
      // A UNIQUE violation is the replay case: an idempotent no-op, not an error.
      if (String(err).includes("UNIQUE")) return { applied: false };
      throw err;
    }
  },
}));

vi.mock("~/lib/stripe/webhook", () => ({
  constructStripeEvent: async () => {
    if (!harness.signatureValid) throw new Error("bad signature");
    return harness.event as Stripe.Event;
  },
}));

vi.mock("@sentry/cloudflare", () => ({ captureException: () => {} }));

const { action } = await import("~/routes/webhooks/stripe-platform");
const { cloudflareContext } = await import("~/lib/cloudflare-context");
const schema = await import("~/db/schema");

function invoicePaidEvent(eventId: string, billingInvoiceId: string | null): Stripe.Event {
  return {
    id: eventId,
    type: "invoice.paid",
    data: {
      object: {
        id: "in_platform_1",
        hosted_invoice_url: "https://pay.stripe.com/platform",
        metadata: billingInvoiceId ? { billing_invoice_id: billingInvoiceId } : {},
      },
    },
  } as unknown as Stripe.Event;
}

/** Drive the real route action with a POST and a stubbed request context. */
function post(): Promise<Response> {
  const env = { STRIPE_PLATFORM_WEBHOOK_SECRET: "whsec_test" } as unknown as Env;
  const context = {
    get: (key: unknown) => {
      if (key !== cloudflareContext) throw new Error("unexpected context key");
      return { env, ctx: {} as ExecutionContext, nonce: "n" };
    },
  };
  const request = new Request("https://app.foxhoundapp.com/webhooks/stripe-platform", {
    method: "POST",
    body: "{}",
    headers: { "stripe-signature": "t=1,v1=sig" },
  });
  return action({ request, context } as never) as Promise<Response>;
}

async function seed() {
  const { sqlite, db } = createInMemoryDb();
  harness.db = db;
  harness.sqlite = sqlite;
  await db.insert(schema.accounts).values({ id: ACCOUNT_ID, name: "Platform Co", createdAt: RECEIVED_AT });
  await db.insert(schema.billingInvoices).values({
    id: BILLING_INVOICE_ID,
    accountId: ACCOUNT_ID,
    currency: "usd",
    periodStart: new Date("2026-07-01T00:00:00.000Z"),
    periodEnd: new Date("2026-08-01T00:00:00.000Z"),
    status: "finalized",
    totalCents: 2_000,
    idempotencyKey: "billing:acc_platform:usd:2026-07",
    createdAt: RECEIVED_AT,
  });
  return db;
}

beforeEach(() => {
  harness.signatureValid = true;
  harness.failNextCommit = false;
});

describe("platform webhook: a dispatch failure must not claim the event", () => {
  it("returns 5xx and commits NO webhook_events row when the batch fails", async () => {
    const db = await seed();
    harness.event = invoicePaidEvent("evt_lost_paid", BILLING_INVOICE_ID);
    harness.failNextCommit = true;

    const res = await post();

    // Pre-fix: 200. Stripe would have stopped retrying a payment it had taken.
    expect(res.status).toBe(500);
    // Pre-fix: one row, processed=true, for an event that was never applied.
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
    const [invoice] = await db.select().from(schema.billingInvoices);
    expect(invoice.status).toBe("finalized");
  });

  it("the redelivery after that failure then applies exactly once", async () => {
    const db = await seed();
    harness.event = invoicePaidEvent("evt_lost_paid", BILLING_INVOICE_ID);

    harness.failNextCommit = true;
    expect((await post()).status).toBe(500);

    // Stripe redelivers the same event id.
    harness.failNextCommit = false;
    const retry = await post();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ received: true, outcome: "applied" });

    const [invoice] = await db.select().from(schema.billingInvoices);
    expect(invoice.status).toBe("paid");
    expect(invoice.stripeInvoiceId).toBe("in_platform_1");
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(1);

    // And a THIRD delivery is a duplicate no-op, not a second application.
    const third = await post();
    expect(third.status).toBe(200);
    expect(await third.json()).toEqual({ received: true, outcome: "duplicate" });
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(1);
  });
});

describe("platform webhook: events with nothing to apply", () => {

  it("claims and ignores an event whose billing_invoice_id matches no row", async () => {
    const db = await seed();
    harness.event = invoicePaidEvent("evt_unknown_row", "binv_does_not_exist");

    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "ignored" });
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(1);
  });
});

describe("platform webhook: unchanged guards", () => {
  it("still rejects a bad signature with a 400, before any claim", async () => {
    const db = await seed();
    harness.event = invoicePaidEvent("evt_bad_sig", BILLING_INVOICE_ID);
    harness.signatureValid = false;

    const res = await post();
    expect(res.status).toBe(400);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });
});
