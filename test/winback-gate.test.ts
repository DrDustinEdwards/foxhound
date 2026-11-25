import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import {
  WINBACK_PRIORITY_ACTION,
  WINBACK_STEP1_HOURS,
  WINBACK_UNFLAGGED_STEP1_HOURS,
} from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// An unflagged customer's first win-back step is delayed to 4h; a winback_priority one keeps 1h.

const ACCOUNT_ID = "acc_rewire";
const CONNECTION_ID = "conn_rewire";
const CONNECTED_ACCOUNT = "acct_connected";
const CUSTOMER_ID = "cus_rewire";
const NOW = new Date("2026-08-14T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (
    _env: Env,
    write: { build: (db: unknown) => unknown[] },
  ): Promise<{ applied: boolean }> => {
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
      return { applied: true };
    } catch (err) {
      if (String(err).includes("UNIQUE")) return { applied: false };
      throw err;
    }
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({ decryptToken: async () => "sk_test_connected" }));
vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    customers: {
      retrieve: async () => ({ email: "jordan@example.com", name: "Jordan Lee", deleted: false }),
    },
  }),
  getStripe: () => {
    throw new Error("platform stripe must not be used here");
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const schema = await import("~/db/schema");

/** A cancellation event for the seeded customer.  */
function deletionEvent(eventId: string): Stripe.Event {
  return {
    id: eventId,
    account: CONNECTED_ACCOUNT,
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: `sub_${eventId}`,
        customer: CUSTOMER_ID,
        cancellation_details: { reason: "cancellation_requested" },
        items: {
          data: [{ price: { unit_amount: 4900, currency: "usd", product: { name: "Growth" } } }],
        },
      },
    },
  } as unknown as Stripe.Event;
}

/** Seed an eligible win-back: an account and a connection. */
async function seed(opts: {
  recommendedAction?: string;
}): Promise<ReturnType<typeof createInMemoryDb>> {
  const made = createInMemoryDb();
  harness.db = made.db;
  const db = made.db;

  await db.insert(schema.accounts).values({ id: ACCOUNT_ID, name: "Mine", createdAt: NOW });
  await db.insert(schema.stripeConnections).values({
    id: CONNECTION_ID,
    accountId: ACCOUNT_ID,
    stripeUserId: CONNECTED_ACCOUNT,
    stripeAccessToken: "enc_token",
    createdAt: NOW,
  });
  if (opts.recommendedAction !== undefined) {
    await db.insert(schema.customerContext).values({
      accountId: ACCOUNT_ID,
      stripeCustomerId: CUSTOMER_ID,
      healthFactors: { recommended_action: opts.recommendedAction },
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return made;
}

/** The offset in hours from cancellation to the first win-back step, read back
 *  from the row the processor actually wrote. */
function step1OffsetHours(sqlite: ReturnType<typeof createInMemoryDb>["sqlite"]): number {
  const row = sqlite
    .prepare("select scheduled_at from win_back_steps where step_number = 1")
    .get() as { scheduled_at: number } | undefined;
  if (!row) throw new Error("no step 1 was written: the win-back path did not run");
  return (row.scheduled_at - NOW.getTime()) / HOUR_MS;
}

describe("the win-back gate on every account, end to end", () => {
  it("with no customer_context row the customer is unflagged, so 4h", async () => {
    const { sqlite } = await seed({});
    await processConnectedWebhook({} as Env, deletionEvent("evt_c"), NOW);
    expect(step1OffsetHours(sqlite)).toBe(WINBACK_UNFLAGGED_STEP1_HOURS);
  });

  it("flagged winback_priority: keeps the 1h default", async () => {
    const { sqlite } = await seed({ recommendedAction: WINBACK_PRIORITY_ACTION });
    await processConnectedWebhook({} as Env, deletionEvent("evt_d"), NOW);
    expect(step1OffsetHours(sqlite)).toBe(WINBACK_STEP1_HOURS);
  });
});
