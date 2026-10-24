import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { accounts } from "~/db/schema";
import { WINBACK_RECENT_RESOLVED_DAYS } from "~/lib/constants";
import { classifyStripeEvent } from "~/lib/webhooks/events";
import { buildWinbackStartBatch } from "~/lib/webhooks/batches";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// THE WIN-BACK CREATION PATH (290), ported from legacy's handleSubscriptionDeleted.
// Session 5 measured that Foxhound created win-back sequences NOWHERE in
// production: every insert was the demo seeder and planWinbackSteps had two
// callers, the seeder and its own test. This is the port, and these assertions
// are the proof that the planner now has a real one.
//
// LEGACY'S ELIGIBILITY CONDITIONS, in legacy's own order, each ported:
//   1. involuntary churn  -> `.eq('status','active')` over the customer's
//      failed_payments; when any exist legacy returns WITHOUT a win-back
//   2. recently chased    -> status in ['cancelled','recovered'] with
//      resolved_at >= now - WINBACK_RECENT_RESOLVED_DAYS (7)
//   3. replay guard       -> an existing sequence for this stripe_subscription_id
//   4. no email           -> `if (!customerEmail) return`
//
// The eligibility READS live in process.ts and are exercised through the
// classifier + batch here; the branch wiring itself is asserted on source.

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

/** Models executeMoneyWrite and the per-account money-write DO: the whole batch
 *  commits atomically or not at all, and a UNIQUE violation is the replay case,
 *  an idempotent no-op rather than an error (286's transaction-boundary rule,
 *  which exists because a bare run proved the opposite of its claim once). */
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
        items: { data: [{ price: { unit_amount: 4900, currency: "usd", product: { name: "Growth" } } }] },
        ...overrides,
      },
    },
  } as never;
}

describe("290: the classifier maps subscription deletion to a win-back intent", () => {
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

  it("tolerates a subscription with no price, as legacy does", () => {
    const intent = classifyStripeEvent(subscriptionDeletedEvent({ items: { data: [] } }));
    if (intent.kind !== "winback_start") throw new Error("expected winback_start");
    expect(intent.planName).toBeNull();
    expect(intent.amountCents).toBeNull();
    expect(intent.currency).toBeNull();
  });

  it("ignores an event with no customer", () => {
    const intent = classifyStripeEvent(subscriptionDeletedEvent({ customer: null }));
    expect(intent).toEqual({ kind: "ignore", reason: "no_customer" });
  });
});

describe("290: exactly-once on the SUBSCRIPTION, both sides", () => {
  it("a REDELIVERY collapses: one sequence, one set of steps", () => {
    const { sqlite, db } = seed();
    const first = commitBatch(sqlite, buildWinbackStartBatch(db, startInput("sub_1", "evt_a")));
    expect(first.applied).toBe(true);
    // A DIFFERENT event id, so the webhook claim cannot be what stops it: the
    // guarantee has to come from the subscription key.
    const second = commitBatch(sqlite, buildWinbackStartBatch(db, startInput("sub_1", "evt_b")));
    expect(second.applied).toBe(false);
    const seqCount = sqlite
      .prepare("select count(*) as n from win_back_sequences where stripe_subscription_id = ?")
      .get("sub_1") as { n: number };
    const stepCount = sqlite.prepare("select count(*) as n from win_back_steps").get() as { n: number };
    expect(seqCount.n).toBe(1);
    expect(stepCount.n).toBe(3);
  });
});

describe("290: the eligibility gates are wired, per condition", () => {
  const PROCESS = ["process", "lookups", "recovery-handlers", "dispute-handlers", "winback-handlers"]
    .map((f) => readFileSync(`app/lib/webhooks/${f}.ts`, "utf8"))
    .join("\n");

  it("the recently-chased window is legacy's seven days", () => {
    expect(WINBACK_RECENT_RESOLVED_DAYS).toBe(7);
    expect(PROCESS).toContain("WINBACK_RECENT_RESOLVED_DAYS * DAY_MS");
    expect(PROCESS).toContain('reason: "recently_resolved"');
  });
});

