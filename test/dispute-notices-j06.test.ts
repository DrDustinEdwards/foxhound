import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J06 (job_4f4c9c2f5383): the merchant's dispute notices, driven through the
// real webhook processor. Recova sends them from lib/dispute-handlers.ts (blob
// e2bb8de8): sendDisputeCreatedEmail at the end of handleDisputeCreated and
// sendDisputeOutcomeEmail in handleDisputeClosed, once per dispute
// (outcome_notified_at). The words are lib/disputes-email.ts (blob 156719f1).
//
// EVERY ASSERTION READS THE SENT MESSAGE OR A TABLE, never a helper's return
// value, so a mutation that detaches a send goes red where it matters.

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  seen: new Set<string>(),
  sent: [] as { from: string; to: string; subject: string; html: string }[],
  creditNotes: 0,
}));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// The money-write DO, faithfully enough for these tests: a key it has seen is a
// no-op, and a batch that throws (the webhook_events unique index on a replay)
// rolls back whole and reports applied=false.
vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: async (_env: Env, write: { idempotencyKey: string; build: (db: unknown) => unknown[] }) => {
    if (harness.seen.has(write.idempotencyKey)) return { applied: false };
    const sqlite = harness.sqlite as Database.Database;
    sqlite.exec("BEGIN");
    try {
      await (harness.db as { batch: (s: unknown[]) => Promise<unknown> }).batch(write.build(harness.db));
      sqlite.exec("COMMIT");
    } catch (err) {
      sqlite.exec("ROLLBACK");
      if (/UNIQUE constraint failed/.test(String(err))) return { applied: false };
      throw err;
    }
    harness.seen.add(write.idempotencyKey);
    return { applied: true };
  },
}));

vi.mock("~/lib/billing/credit-note", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/billing/credit-note")>()),
  issueCreditNoteForEvidence: async () => {
    harness.creditNotes++;
    return { credited: false, reason: "no_charged_fee_line" };
  },
}));

const { processConnectedWebhook } = await import("~/lib/webhooks/process");
const { DISPUTE_CREATED_TEMPLATE, nextDisputeBillingRun } = await import(
  "~/lib/disputes/notices"
);

const ACCOUNT = "acct_1";
const RECEIVED = new Date("2026-11-10T12:00:00Z");
const DUE_BY = Date.UTC(2026, 10, 24, 23, 59, 59) / 1000;

const env = {
  ENCRYPTION_KEY: "ab".repeat(32),
  BETTER_AUTH_URL: "https://foxhoundapp.test",
  EMAIL: {
    send: async (m: { from: string; to: string; subject: string; html: string }) => {
      harness.sent.push(m);
      return { id: `msg_${harness.sent.length}` };
    },
  },
} as unknown as Env;

let sqlite: Database.Database;

beforeEach(() => {
  const made = createInMemoryDb();
  sqlite = made.sqlite;
  harness.db = made.db;
  harness.sqlite = made.sqlite;
  harness.seen = new Set();
  harness.sent = [];
  harness.creditNotes = 0;
});

function seedAccount(opts: { notificationEmail?: string | null; paused?: boolean; liveSends?: boolean } = {}) {
  sqlite
    .prepare(
      "INSERT INTO accounts (id, name, created_at, notification_email, processing_paused, live_sends_enabled) VALUES (?, 'Acme', 1000, ?, ?, ?)",
    )
    .run(
      ACCOUNT,
      opts.notificationEmail === undefined ? "ops@acme.test" : opts.notificationEmail,
      opts.paused ? 1 : 0,
      opts.liveSends === false ? 0 : 1,
    );
  sqlite
    .prepare(
      "INSERT INTO stripe_connections (id, account_id, stripe_user_id, is_primary, stripe_access_token, connected_at, created_at) VALUES ('c1', ?, 'acct_stripe', 1, 'cipher', 1000, 1000)",
    )
    .run(ACCOUNT);
}

function seedDispute(opts: { state?: string; submitted?: boolean; customerName?: string | null } = {}) {
  sqlite
    .prepare(
      "INSERT INTO disputes (id, account_id, stripe_dispute_id, stripe_charge_id, customer_name, customer_email, amount_cents, currency, reason, status, state, submitted_at, created_at, stripe_connection_id) VALUES ('d1', ?, 'dp_1', 'ch_1', ?, 'buyer@acme.test', 5000, 'usd', 'product_not_received', 'needs_response', ?, ?, 1000, 'c1')",
    )
    .run(ACCOUNT, opts.customerName === undefined ? "Jane Buyer" : opts.customerName, opts.state ?? "pending_review", opts.submitted ? 2000 : null);
}

function createdEvent(id = "evt_c1") {
  return {
    id,
    type: "charge.dispute.created",
    account: "acct_stripe",
    data: {
      object: {
        id: "dp_1",
        object: "dispute",
        charge: "ch_1",
        payment_intent: null,
        amount: 5000,
        currency: "usd",
        reason: "product_not_received",
        status: "needs_response",
        evidence_details: { due_by: DUE_BY },
        created: Math.floor(RECEIVED.getTime() / 1000),
      },
    },
  } as never;
}

function closedEvent(status: "won" | "lost", id = "evt_x1") {
  return {
    id,
    type: "charge.dispute.closed",
    account: "acct_stripe",
    data: { object: { id: "dp_1", object: "dispute", charge: "ch_1", amount: 5000, currency: "usd", status } },
  } as never;
}

function sendRows() {
  return sqlite
    .prepare("SELECT status, template FROM email_sends WHERE account_id = ? ORDER BY created_at")
    .all(ACCOUNT) as { status: string; template: string }[];
}

function disputeRowId(): string {
  return (sqlite.prepare("SELECT id FROM disputes WHERE stripe_dispute_id = 'dp_1'").get() as { id: string }).id;
}

function outcomeNotifiedAt(): number | null {
  return (sqlite.prepare("SELECT outcome_notified_at AS at FROM disputes WHERE stripe_dispute_id = 'dp_1'").get() as {
    at: number | null;
  }).at;
}

describe("NOTICE 1: a new dispute notifies the merchant", () => {
  it("one email to the notification address, after the intake commits", async () => {
    seedAccount();
    const result = await processConnectedWebhook(env, createdEvent(), RECEIVED);

    expect(result).toEqual({ status: "applied" });
    expect(harness.sent).toHaveLength(1);
    const mail = harness.sent[0];
    expect(mail.to).toBe("ops@acme.test");
    // Recova: `New dispute: ${amount} from ${customerLabel}`, the label falling
    // back to "Unknown customer" when the charge carries no name or email.
    expect(mail.subject).toBe("New dispute: $50.00 from Unknown customer");
    expect(mail.from).toContain("Foxhound");
    expect(mail.html).toMatch(/<h1[^>]*>New dispute\.<\/h1>/);
    expect(mail.html).toContain("Product Not Received");
    expect(mail.html).toContain("2026-11-24");
    // The account never turned auto-submit on, so Recova's off sentence.
    expect(mail.html).toContain("Auto-submit is off. We will remind you 3 days before the deadline.");
    expect(mail.html).toContain(`https://foxhoundapp.test/disputes/${disputeRowId()}`);
    // A merchant notice: no unsubscribe link (RULES.md 3.16).
    expect(mail.html.toLowerCase()).not.toContain("unsubscribe");
    expect(sendRows()).toEqual([{ status: "sent", template: DISPUTE_CREATED_TEMPLATE }]);
  });

  it("a redelivered event sends nothing more", async () => {
    seedAccount();
    await processConnectedWebhook(env, createdEvent(), RECEIVED);
    const replay = await processConnectedWebhook(env, createdEvent(), RECEIVED);
    expect(replay).toEqual({ status: "duplicate" });
    expect(harness.sent).toHaveLength(1);
  });

  it("no notification address: the dispute is still recorded and nothing is sent", async () => {
    seedAccount({ notificationEmail: null });
    const result = await processConnectedWebhook(env, createdEvent(), RECEIVED);
    expect(result).toEqual({ status: "applied" });
    expect(disputeRowId()).toBeTruthy();
    expect(harness.sent).toHaveLength(0);
    expect(sendRows()).toHaveLength(0);
  });

  it("a paused account is not notified, as Recova returns before its email", async () => {
    seedAccount({ paused: true });
    await processConnectedWebhook(env, createdEvent(), RECEIVED);
    expect(harness.sent).toHaveLength(0);
  });
});

describe("NOTICE 2 and 3: a closed dispute tells the merchant it was won or lost", () => {

  it("lost: Recova's lost notice, no fee", async () => {
    seedAccount();
    seedDispute();
    await processConnectedWebhook(env, closedEvent("lost"), RECEIVED);
    expect(harness.sent).toHaveLength(1);
    const mail = harness.sent[0];
    expect(mail.subject).toBe("Dispute lost: $50.00");
    expect(mail.html).toMatch(/<h1[^>]*>Dispute closed as lost\.<\/h1>/);
    expect(mail.html).toContain("No Foxhound fee. We only charge when we win.");
    expect(outcomeNotifiedAt()).not.toBeNull();
  });

  it("a dispute already resolved by an Accept still gets Recova's lost notice when Stripe closes it", async () => {
    seedAccount();
    seedDispute({ state: "resolved_lost" });
    const result = await processConnectedWebhook(env, closedEvent("lost"), RECEIVED);
    expect(result).toEqual({ status: "ignored", reason: "already_resolved" });
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].subject).toBe("Dispute lost: $50.00");
  });

  it("no notification address: resolved, unnotified, unstamped", async () => {
    seedAccount({ notificationEmail: null });
    seedDispute();
    await processConnectedWebhook(env, closedEvent("lost"), RECEIVED);
    expect(harness.sent).toHaveLength(0);
    expect(outcomeNotifiedAt()).toBeNull();
    const state = sqlite.prepare("SELECT state FROM disputes WHERE id = 'd1'").get() as { state: string };
    expect(state.state).toBe("resolved_lost");
  });
});

describe("the invoice date is the next monthly billing run after resolution", () => {

  it("a win resolved on the 1st before the run is billed by that same run", () => {
    expect(nextDisputeBillingRun(new Date("2026-12-01T01:00:00Z")).toISOString().slice(0, 10)).toBe("2026-12-01");
    expect(nextDisputeBillingRun(new Date("2026-12-01T05:00:00Z")).toISOString().slice(0, 10)).toBe("2027-01-01");
  });
});

describe("PR 149 review: the notices hold when a delivery is cut short or the account is paused", () => {
  it("a redelivery sends the new-dispute notice the first delivery never sent", async () => {
    // The first delivery commits the intake but no notice leaves (as if the
    // Worker died after the commit): here the address is not set yet.
    seedAccount({ notificationEmail: null });
    await processConnectedWebhook(env, createdEvent(), RECEIVED);
    expect(harness.sent).toHaveLength(0);
    sqlite.prepare("UPDATE accounts SET notification_email = 'ops@acme.test' WHERE id = ?").run(ACCOUNT);

    const replay = await processConnectedWebhook(env, createdEvent(), RECEIVED);
    expect(replay).toEqual({ status: "duplicate" });
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].subject).toBe("New dispute: $50.00 from Unknown customer");
    // And the send key still holds it to one: a third delivery sends nothing.
    await processConnectedWebhook(env, createdEvent(), RECEIVED);
    expect(harness.sent).toHaveLength(1);
  });
});
