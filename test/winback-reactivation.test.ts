import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// JOB 3 / 343 binding 3 and 344 binding 1: THE REACTIVATION.
//
// TWO EVENTS, ONE CLAIM. checkout.session.completed carries the sequence id
// directly; invoice.payment_succeeded carries it on the subscription. Either
// flips the sequence, whichever arrives first, and the second flips nothing.
//
// THE MATCH IS THE ID, NEVER THE CUSTOMER. Legacy selects on
// (account_id, stripe_customer_id, status='active') and compares no
// subscription, so a customer holding two subscriptions who cancels one and
// pays the other's ordinary renewal is credited as a win-back. The
// two-subscription fixture below is what proves Foxhound does not.
//
// AND NOTHING ABOUT IT IS BILLABLE (343 binding 1): no recovered_payments row,
// no attribution signal, and the fee base is asserted unchanged across a
// reactivation.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  subscriptions: {} as Record<string, { metadata?: Record<string, string> }>,
  retrieved: [] as string[],
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { build: (db: unknown) => unknown[] }) => {
    const batch = write.build(harness.db);
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(batch);
      return { applied: true };
    } catch {
      return { applied: false };
    }
  },
}));

vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async (_e: unknown, c: string) => `plain:${c}`,
}));

vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({
    subscriptions: {
      retrieve: async (id: string) => {
        harness.retrieved.push(id);
        const sub = harness.subscriptions[id];
        if (!sub) throw new Error("no such subscription");
        return sub;
      },
    },
    customers: { retrieve: async () => ({ id: "cus_1", email: "b@a.test", name: null }) },
  }),
  getStripe: () => ({}),
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { classifyStripeEvent } = await import("~/lib/webhooks/events");
const { claimWinbackReactivation, daysSinceCancel } = await import(
  "~/lib/recovery/winback-reactivation.server"
);
const { findAttributionSignals } = await import("~/lib/recovery/attribution");
const { readWinbackSequenceId } = await import("~/lib/recovery/winback-metadata");
const { getBillableRecoveries } = await import("~/db/billable");

const ACCOUNT = "acct_1";
const CANCELLED_AT = new Date("2026-10-20T00:00:00Z");
const RECEIVED = new Date("2026-11-01T00:00:00Z");
const env = { ENCRYPTION_KEY: "ab".repeat(32) } as unknown as Env;

let sqlite: Database.Database;
let db: ReturnType<typeof createInMemoryDb>["db"];

beforeEach(() => {
  ({ sqlite, db } = createInMemoryDb());
  harness.db = db;
  harness.subscriptions = {};
  harness.retrieved = [];
  sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES (?, 'Acme', 1000)").run(ACCOUNT);
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES ('c1', ?, 'acct_stripe', 1, 'cipher', 1000, 1000)",
    )
    .run(ACCOUNT);
});

function seedSequence(
  opts: { id?: string; status?: string; customerId?: string; accountId?: string } = {},
): string {
  const id = opts.id ?? "wb_1";
  sqlite
    .prepare(
      "INSERT INTO win_back_sequences (id, account_id, stripe_customer_id, stripe_subscription_id, customer_email, plan_name, amount_cents, currency, status, created_at, stripe_connection_id) VALUES (?, ?, ?, ?, 'buyer@acme.test', 'Pro', 4900, 'usd', ?, ?, 'c1')",
    )
    .run(
      id,
      opts.accountId ?? ACCOUNT,
      opts.customerId ?? "cus_1",
      `sub_dead_${id}`,
      opts.status ?? "active",
      CANCELLED_AT.getTime(),
    );
  return id;
}

function checkoutEvent(metadata: Record<string, string> | null, id = "evt_c1") {
  return {
    id,
    type: "checkout.session.completed",
    account: "acct_stripe",
    data: { object: { id: "cs_1", customer: "cus_1", metadata } },
  } as never;
}

function invoiceEvent(subscriptionId: string | null, id = "evt_i1", customer = "cus_1") {
  return {
    id,
    type: "invoice.payment_succeeded",
    account: "acct_stripe",
    data: {
      object: {
        id: `in_${id}`,
        customer,
        subscription: subscriptionId,
        amount_paid: 4900,
        currency: "usd",
      },
    },
  } as never;
}

function sequenceRows() {
  return sqlite
    .prepare(
      "SELECT id, status, reactivated_at AS reactivatedAt FROM win_back_sequences ORDER BY id",
    )
    .all() as { id: string; status: string; reactivatedAt: number | null }[];
}

function outcomeRows() {
  return sqlite
    .prepare(
      "SELECT event_type AS eventType, outcome, event_data AS eventData, idempotency_key AS key FROM outcomes",
    )
    .all() as { eventType: string; outcome: string; eventData: string; key: string }[];
}

describe("PLANT 1: the classifier reads the sequence id off the session", () => {
  it("classifies a win-back checkout", () => {
    const intent = classifyStripeEvent(checkoutEvent({ win_back_sequence_id: "wb_1" }));
    expect(intent.kind).toBe("winback_reactivate");
    expect(intent.kind === "winback_reactivate" && intent.sequenceId).toBe("wb_1");
  });

  it("IGNORES an ordinary checkout that carries no win-back metadata", () => {
    expect(classifyStripeEvent(checkoutEvent(null)).kind).toBe("ignore");
    expect(classifyStripeEvent(checkoutEvent({ other: "x" })).kind).toBe("ignore");
    expect(classifyStripeEvent(checkoutEvent({ win_back_sequence_id: "" })).kind).toBe("ignore");
  });

  it("THE HELPER ITSELF REFUSES AN EMPTY VALUE, reached past the classifier's guard", () => {
    // classifyStripeEvent's own `if (!sequenceId)` also refuses an empty
    // string, so the helper's rule was never observable through it.
    expect(readWinbackSequenceId({ win_back_sequence_id: "" })).toBeNull();
    expect(readWinbackSequenceId({})).toBeNull();
    expect(readWinbackSequenceId(null)).toBeNull();
    expect(readWinbackSequenceId({ win_back_sequence_id: "wb_9" })).toBe("wb_9");
  });

  it("carries the invoice's subscription onto the recover intent", () => {
    const intent = classifyStripeEvent(invoiceEvent("sub_new"));
    expect(intent.kind === "recover" && intent.subscriptionId).toBe("sub_new");
  });
});

describe("PLANT 2: checkout.session.completed reactivates", () => {
  it("flips the sequence and records legacy's outcome", async () => {
    seedSequence();

    const result = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }),
      RECEIVED,
    );

    expect(result).toEqual({ status: "applied" });
    expect(sequenceRows()).toEqual([
      { id: "wb_1", status: "reactivated", reactivatedAt: RECEIVED.getTime() },
    ]);

    const rows = outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("winback_reactivated");
    expect(rows[0].outcome).toBe("reactivated");
    expect(JSON.parse(rows[0].eventData)).toEqual({ amountCents: 4900, daysSinceCancel: 12 });
    expect(rows[0].key).toBe("winback-reactivated:wb_1");
  });

  it("AN EXHAUSTED SEQUENCE STILL REACTIVATES, because step 3 flipped it on send", async () => {
    seedSequence({ status: "exhausted" });

    await processConnectedWebhook(env, checkoutEvent({ win_back_sequence_id: "wb_1" }), RECEIVED);

    expect(sequenceRows()[0].status).toBe("reactivated");
    expect(outcomeRows()).toHaveLength(1);
  });

  it("a sequence on ANOTHER account is not found, and nothing flips", async () => {
    sqlite.prepare("INSERT INTO accounts (id, name, created_at) VALUES ('acct_other', 'Other', 1000)").run();
    seedSequence({ accountId: "acct_other" });

    const result = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }),
      RECEIVED,
    );

    expect(result).toEqual({ status: "ignored", reason: "winback_not_found" });
    expect(sequenceRows()[0].status).toBe("active");
    expect(outcomeRows()).toEqual([]);
  });

  it("a REDELIVERY of the same event flips nothing and records nothing", async () => {
    seedSequence();
    await processConnectedWebhook(env, checkoutEvent({ win_back_sequence_id: "wb_1" }), RECEIVED);

    const again = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }, "evt_c1"),
      RECEIVED,
    );

    expect(again).toEqual({ status: "duplicate" });
    expect(outcomeRows()).toHaveLength(1);
  });

  it("A NEW EVENT ID FOR THE SAME SEQUENCE ALSO RECORDS NOTHING, reaching the STATUS claim alone", async () => {
    // The webhook claim cannot refuse this one, so only the status condition
    // on the flip can (340 binding 3).
    seedSequence();
    await processConnectedWebhook(env, checkoutEvent({ win_back_sequence_id: "wb_1" }, "evt_c1"), RECEIVED);

    const again = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }, "evt_c2"),
      new Date(RECEIVED.getTime() + 60_000),
    );

    expect(again).toEqual({ status: "ignored", reason: "winback_already_handled" });
    expect(outcomeRows()).toHaveLength(1);
    expect(sequenceRows()[0].reactivatedAt).toBe(RECEIVED.getTime());
  });

  it("A LOST CLAIM RECORDS NO OUTCOME, reaching that guard past the status check", async () => {
    // The status pre-check normally refuses first, so the `if (!claimed)`
    // guard is unreachable through it. `reactivated_at` already set with the
    // status still active is exactly the state the claim's second condition
    // exists for, and it lets the load succeed while the claim fails.
    seedSequence();
    sqlite
      .prepare("UPDATE win_back_sequences SET reactivated_at = ? WHERE id = 'wb_1'")
      .run(RECEIVED.getTime() - 1000);

    const result = await processConnectedWebhook(
      env,
      checkoutEvent({ win_back_sequence_id: "wb_1" }),
      RECEIVED,
    );

    expect(result).toEqual({ status: "ignored", reason: "winback_duplicate" });
    expect(outcomeRows()).toEqual([]);
  });

  it("the claim itself refuses a second take", async () => {
    seedSequence();
    expect(await claimWinbackReactivation(db, "wb_1", RECEIVED)).toBe(true);
    expect(await claimWinbackReactivation(db, "wb_1", new Date(RECEIVED.getTime() + 1))).toBe(false);
  });
});

describe("PLANT 3: invoice.payment_succeeded reactivates by METADATA, never by customer", () => {
  it("reactivates when the paid subscription carries the sequence id", async () => {
    seedSequence();
    harness.subscriptions["sub_new"] = { metadata: { win_back_sequence_id: "wb_1" } };

    await processConnectedWebhook(env, invoiceEvent("sub_new"), RECEIVED);

    expect(harness.retrieved).toEqual(["sub_new"]);
    expect(sequenceRows()[0].status).toBe("reactivated");
    expect(outcomeRows().map((r) => r.eventType)).toEqual(["winback_reactivated"]);
  });

  it("THE TWO-SUBSCRIPTION FIXTURE: an unrelated renewal for the SAME customer reactivates nothing", async () => {
    // This is the fixture that separates legacy's match from Foxhound's. The
    // customer has a live win-back for the subscription they cancelled AND a
    // second, surviving subscription. Legacy would credit this renewal as a
    // win-back; matching on the metadata id refuses it.
    seedSequence();
    harness.subscriptions["sub_other"] = { metadata: {} };

    await processConnectedWebhook(env, invoiceEvent("sub_other"), RECEIVED);

    expect(harness.retrieved).toEqual(["sub_other"]);
    expect(sequenceRows()[0].status).toBe("active");
    expect(sequenceRows()[0].reactivatedAt).toBeNull();
    expect(outcomeRows()).toEqual([]);
  });

  it("A CUSTOMER WITH NO LIVE SEQUENCE COSTS NO STRIPE READ", async () => {
    // The prefilter is a cost guard: no candidate, no retrieve.
    await processConnectedWebhook(env, invoiceEvent("sub_new"), RECEIVED);

    expect(harness.retrieved).toEqual([]);
    expect(outcomeRows()).toEqual([]);
  });

  it("a Stripe failure is swallowed and the webhook still completes", async () => {
    seedSequence();
    // No subscription registered, so retrieve throws.

    const result = await processConnectedWebhook(env, invoiceEvent("sub_missing"), RECEIVED);

    expect(result).toEqual({ status: "ignored", reason: "no_active_failure" });
    expect(sequenceRows()[0].status).toBe("active");
  });

  it("BOTH EVENTS TOGETHER FLIP ONCE, whichever order they arrive in", async () => {
    seedSequence();
    harness.subscriptions["sub_new"] = { metadata: { win_back_sequence_id: "wb_1" } };

    await processConnectedWebhook(env, checkoutEvent({ win_back_sequence_id: "wb_1" }), RECEIVED);
    await processConnectedWebhook(
      env,
      invoiceEvent("sub_new"),
      new Date(RECEIVED.getTime() + 60_000),
    );

    expect(outcomeRows()).toHaveLength(1);
    expect(sequenceRows()[0].reactivatedAt).toBe(RECEIVED.getTime());
  });
});

describe("PLANT 4: nothing about a reactivation is billable", () => {
  it("writes no recovered_payments row and no attribution signal", async () => {
    seedSequence();

    await processConnectedWebhook(env, checkoutEvent({ win_back_sequence_id: "wb_1" }), RECEIVED);

    expect(sqlite.prepare("SELECT id FROM recovered_payments").all()).toEqual([]);
    expect(sqlite.prepare("SELECT id FROM recovery_steps").all()).toEqual([]);
  });

  it("THE FEE BASE IS UNCHANGED ACROSS A REACTIVATION", async () => {
    seedSequence();
    const before = await getBillableRecoveries(db, ACCOUNT, RECEIVED.getTime());

    await processConnectedWebhook(env, checkoutEvent({ win_back_sequence_id: "wb_1" }), RECEIVED);

    const after = await getBillableRecoveries(db, ACCOUNT, RECEIVED.getTime());
    expect(after).toEqual(before);
    expect(after).toEqual([]);
  });

  it("findAttributionSignals reads recovery_steps and a win-back has none", () => {
    // The reader's input type IS recovery_steps rows. A win-back writes none,
    // so there is nothing for it to attribute, by construction.
    expect(findAttributionSignals([])).toEqual({
      succeededRetryStepId: null,
      cardUpdateRef: null,
      clickedEngagementId: null,
    });
  });

  it("NEITHER BILLING MODULE NAMES A WIN-BACK TABLE OR EVENT", async () => {
    // Reading the sources is the only way to prove a module does NOT reference
    // something. 343 binding 1 asks for exactly this assertion.
    const { readFileSync } = await import("node:fs");
    for (const path of ["app/db/billable.ts", "app/lib/recovery/attribution.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("winBack");
      expect(source).not.toContain("win_back");
      expect(source).not.toContain("winback");
    }
  });
});

describe("PLANT 5: daysSinceCancel is legacy's whole-day floor", () => {
  it("floors partial days", () => {
    expect(daysSinceCancel(CANCELLED_AT, RECEIVED)).toBe(12);
    expect(daysSinceCancel(CANCELLED_AT, new Date(CANCELLED_AT.getTime() + 86_399_000))).toBe(0);
    expect(daysSinceCancel(CANCELLED_AT, new Date(CANCELLED_AT.getTime() + 86_400_000))).toBe(1);
  });
});
