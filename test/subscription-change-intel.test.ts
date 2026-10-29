import { describe, expect, it } from "vitest";

import { accounts, customerContext } from "~/db/schema";
import { CRITICAL_HEALTH_SCORE_MAX } from "~/lib/intelligence/alerts";
import { HEALTH_SCORE_BASELINE } from "~/lib/intelligence/risk";
import { rescoreCustomer } from "~/lib/intelligence/score-inputs.server";
import { classifyStripeEvent } from "~/lib/webhooks/events";
import { buildSubscriptionChangeBatch } from "~/lib/webhooks/intelligence-handlers";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Intelligence hears a subscription change the same day (2026-10-29): a
// connected account's customer.subscription.updated is recorded beside
// customer_context and the customer is re-scored at once, so the alerts on the
// next recovery tick count a scheduled cancellation as high risk. Taking the
// cancellation back undoes it.

const now = new Date("2026-10-29T12:00:00.000Z");
const periodEnd = Math.floor(Date.UTC(2026, 10, 30) / 1000);

function seed() {
  const { sqlite, db } = createInMemoryDb();
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Mine" }));
  runStatement(
    sqlite,
    db.insert(customerContext).values({
      accountId: "acc_1",
      stripeCustomerId: "cus_1",
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { sqlite, db };
}

function updatedEvent(id: string, object: Record<string, unknown>, previous: Record<string, unknown>) {
  return {
    id,
    type: "customer.subscription.updated",
    account: "acct_1",
    created: Math.floor(now.getTime() / 1000),
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        currency: "usd",
        items: { data: [{ quantity: 1, current_period_end: periodEnd, price: { unit_amount: 4900, recurring: { interval: "month" } } }] },
        ...object,
      },
      previous_attributes: previous,
    },
  } as never;
}

async function record(db: ReturnType<typeof seed>["db"], event: ReturnType<typeof updatedEvent>) {
  const intent = classifyStripeEvent(event);
  if (intent.kind !== "record_subscription_change") return { intent, applied: false };
  const claim = {
    stripeEventId: (event as { id: string }).id,
    eventType: "customer.subscription.updated",
    receivedAt: now,
    accountId: "acc_1",
    payload: {},
  };
  try {
    await db.batch(buildSubscriptionChangeBatch(db, claim, "acc_1", intent, now));
  } catch (err) {
    if (String(err).match(/UNIQUE/)) return { intent, applied: false };
    throw err;
  }
  return { intent, applied: true };
}

async function health(sqlite: ReturnType<typeof seed>["sqlite"]) {
  return sqlite.prepare("select health_score as score, health_factors as factors from customer_context").get() as {
    score: number;
    factors: string;
  };
}

describe("customer.subscription.updated feeds the health score the same day", () => {
  it("a scheduled cancellation puts the customer in the alerts' high-risk band, and taking it back undoes it", async () => {
    const { sqlite, db } = seed();

    const scheduled = await record(db, updatedEvent("evt_cancel", { cancel_at_period_end: true, cancel_at: periodEnd }, { cancel_at_period_end: false, cancel_at: null }));
    expect(scheduled.applied).toBe(true);
    await rescoreCustomer(db, "acc_1", "cus_1", now);
    const after = await health(sqlite);
    expect(after.score).toBeLessThanOrEqual(CRITICAL_HEALTH_SCORE_MAX);
    expect(after.factors).toContain("cancellation scheduled for Nov 30, 2026");

    // A redelivery records nothing twice.
    const replay = await record(db, updatedEvent("evt_cancel", { cancel_at_period_end: true, cancel_at: periodEnd }, { cancel_at_period_end: false, cancel_at: null }));
    expect(replay.applied).toBe(false);

    const reversed = await record(db, updatedEvent("evt_undo", { cancel_at_period_end: false, cancel_at: null }, { cancel_at_period_end: true, cancel_at: periodEnd }));
    expect(reversed.intent).toMatchObject({ changes: [{ kind: "cancel_reversed" }] });
    await rescoreCustomer(db, "acc_1", "cus_1", now);
    expect((await health(sqlite)).score).toBe(HEALTH_SCORE_BASELINE);
  });

  it("records a pause and a lower monthly amount, and ignores an update that changed neither", async () => {
    const paused = classifyStripeEvent(updatedEvent("evt_p", { pause_collection: { behavior: "void", resumes_at: null } }, { pause_collection: null }));
    expect(paused).toMatchObject({ kind: "record_subscription_change", changes: [{ kind: "paused" }] });

    const downgrade = classifyStripeEvent(
      updatedEvent("evt_d", {}, { items: { data: [{ quantity: 1, price: { unit_amount: 9900, recurring: { interval: "month" } } }] } }),
    );
    expect(downgrade).toMatchObject({ changes: [{ kind: "downgraded", previousMrrCents: 9900, currentMrrCents: 4900 }] });

    expect(classifyStripeEvent(updatedEvent("evt_m", {}, { metadata: { a: "b" } }))).toEqual({
      kind: "ignore",
      reason: "no_tracked_subscription_change",
    });
  });
});
