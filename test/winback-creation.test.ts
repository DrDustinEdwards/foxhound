import { describe, expect, it } from "vitest";

import { accounts } from "~/db/schema";
import { classifyStripeEvent } from "~/lib/webhooks/events";
import { buildWinbackStartBatch } from "~/lib/webhooks/batches";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Win-back creation: the classifier maps a subscription deletion to a start intent, and the start batch is exactly-once per subscription.

const now = new Date("2026-08-14T00:00:00.000Z");

function seed() {
  const { sqlite, db } = createInMemoryDb();
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Mine" }));
  return { sqlite, db };
}

function claimFor(eventId: string) {
  return {
    stripeEventId: eventId,
    eventType: "customer.subscription.deleted",
    receivedAt: now,
    accountId: "acc_1",
    payload: { id: eventId },
  };
}

function startInput(subscriptionId: string, eventId = "evt_" + subscriptionId) {
  return {
    claim: claimFor(eventId),
    accountId: "acc_1",
    stripeConnectionId: null,
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: subscriptionId,
    customerEmail: "jordan@example.com",
    customerName: "Jordan Lee",
    planName: "Growth",
    amountCents: 4900,
    currency: "usd",
    cancelReason: "cancellation_requested",
    canceledAt: now,
  };
}

/** Models the money-write DO: the batch commits atomically, and a UNIQUE violation is an idempotent no-op. */
function commitBatch(
  sqlite: ReturnType<typeof createInMemoryDb>["sqlite"],
  batch: unknown[],
): { applied: boolean } {
  sqlite.exec("BEGIN");
  try {
    for (const stmt of batch) runStatement(sqlite, stmt);
    sqlite.exec("COMMIT");
    return { applied: true };
  } catch (err) {
    sqlite.exec("ROLLBACK");
    if (String(err).match(/UNIQUE|constraint/i)) return { applied: false };
    throw err;
  }
}

function subscriptionDeletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        cancellation_details: { reason: "cancellation_requested" },
        items: {
          data: [{ price: { unit_amount: 4900, currency: "usd", product: { name: "Growth" } } }],
        },
        ...overrides,
      },
    },
  } as never;
}

describe("the classifier maps subscription deletion to a win-back intent", () => {
  it("pulls everything reachable without a Stripe call", () => {
    const intent = classifyStripeEvent(subscriptionDeletedEvent());
    expect(intent.kind).toBe("winback_start");
    if (intent.kind !== "winback_start") throw new Error("narrowing");
    expect(intent.subscriptionId).toBe("sub_1");
    expect(intent.customerId).toBe("cus_1");
    expect(intent.cancelReason).toBe("cancellation_requested");
    expect(intent.planName).toBe("Growth");
    expect(intent.amountCents).toBe(4900);
    expect(intent.currency).toBe("usd");
  });

  it("ignores an event with no customer", () => {
    const intent = classifyStripeEvent(subscriptionDeletedEvent({ customer: null }));
    expect(intent).toEqual({ kind: "ignore", reason: "no_customer" });
  });
});

describe("exactly-once on the subscription", () => {
  it("a redelivery collapses: one sequence, one set of steps", () => {
    const { sqlite, db } = seed();
    const first = commitBatch(sqlite, buildWinbackStartBatch(db, startInput("sub_1", "evt_a")));
    expect(first.applied).toBe(true);
    // A different event id, so the guarantee has to come from the subscription key.
    const second = commitBatch(sqlite, buildWinbackStartBatch(db, startInput("sub_1", "evt_b")));
    expect(second.applied).toBe(false);
    const seqCount = sqlite
      .prepare("select count(*) as n from win_back_sequences where stripe_subscription_id = ?")
      .get("sub_1") as { n: number };
    const stepCount = sqlite.prepare("select count(*) as n from win_back_steps").get() as {
      n: number;
    };
    expect(seqCount.n).toBe(1);
    expect(stepCount.n).toBe(3);
  });
});
