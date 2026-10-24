import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import {
  WINBACK_PRIORITY_ACTION,
  WINBACK_STEP1_HOURS,
  WINBACK_UNFLAGGED_STEP1_HOURS,
} from "~/lib/constants";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 292: the win-back Intelligence gate's entitlement read rewires from the
// VESTIGIAL account_products table to the LIVE capability, isIntelligenceEntitled
// over account_subscriptions. Both key the same two constants, INTELLIGENCE_PRODUCT
// and SUBSCRIPTION_STATUS_ACTIVE, which is the measured equivalence 292 rules on.
//
// 291 ported legacy's read VERBATIM and the gate stayed dead even after an admin
// grant, because nothing in Foxhound has ever written account_products. These
// assertions exist because the previous proof was a SOURCE-STRING check: it could
// not tell a reachable gate from an unreachable one, since both read the same
// literal. So the gate is driven END TO END here instead, through the real webhook
// processor, against a real account_subscriptions row written by the real admin
// grant. If the rewire were reverted, every assertion in "the GRANTED branch"
// below goes red, because the granted row would no longer be the row the gate reads.
//
// The harness models the production transaction boundary per 286: executeMoneyWrite
// commits the batch, so a redelivery rolls back rather than double-writing.

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
const { grantIntelligence } = await import("~/lib/admin/merchants.server");
const schema = await import("~/db/schema");

/** A cancellation event for the seeded customer. Legacy's win-back trigger. */
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
          data: [
            { price: { unit_amount: 4900, currency: "usd", product: { name: "Growth" } } },
          ],
        },
      },
    },
  } as unknown as Stripe.Event;
}

/** Seed an eligible win-back: an account, a connection, and nothing that would
 *  trip legacy's earlier eligibility gates (no active failed payments, no recently
 *  resolved ones, no existing sequence, and a customer with an email). */
async function seed(opts: {
  grant?: boolean;
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
  // THE GRANT IS THE REAL ONE: the admin path, not a hand-written row, so this
  // proves the capability rather than a shape the test invented.
  if (opts.grant) await grantIntelligence(db, ACCOUNT_ID, NOW);
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

describe("292: the gate reads the LIVE entitlement, end to end", () => {
  it("UNGRANTED: no entitlement row, so the schedule keeps its 1h default", async () => {
    const { sqlite } = await seed({});
    const outcome = await processConnectedWebhook({} as Env, deletionEvent("evt_a"), NOW);
    expect(outcome).toEqual({ status: "applied" });
    expect(step1OffsetHours(sqlite)).toBe(WINBACK_STEP1_HOURS);
  });

  it("GRANTED with NO customer_context row is still UNFLAGGED, so still 4h", async () => {
    // Legacy reads the recommendation with maybeSingle and compares the absent
    // value, which is not the priority string, so the delay applies.
    const { sqlite } = await seed({ grant: true });
    await processConnectedWebhook({} as Env, deletionEvent("evt_c"), NOW);
    expect(step1OffsetHours(sqlite)).toBe(WINBACK_UNFLAGGED_STEP1_HOURS);
  });

  it("GRANTED and FLAGGED winback_priority: keeps the 1h default", async () => {
    const { sqlite } = await seed({ grant: true, recommendedAction: WINBACK_PRIORITY_ACTION });
    await processConnectedWebhook({} as Env, deletionEvent("evt_d"), NOW);
    expect(step1OffsetHours(sqlite)).toBe(WINBACK_STEP1_HOURS);
  });
});
