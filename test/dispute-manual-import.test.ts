import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, disputes, stripeConnections, type Db } from "~/db";
import {
  MANUAL_CLAIM_EVENT_TYPE,
  importDisputeFromStripe,
  manualImportClaimKey,
} from "~/lib/disputes/manual-import.server";
import { disputeIntakeFields } from "~/lib/disputes/stripe-dispute";
import { SerialMoneyCommitter, type CompiledStatement } from "~/lib/money/serializer";
import { type WebhookClaimInput } from "~/lib/webhooks/batches";
import { buildDisputeIntakeBatch } from "~/lib/webhooks/dispute-batches";

import { createInMemoryDb } from "./helpers/inmemory-db";

// The unique backstop and convergence tests run against real SQLite with the
// real SerialMoneyCommitter; the importer tests mock Stripe and the money write.
// An account's token is its Stripe scope: another account's dispute id is not
// retrievable, so nothing may be written before that lookup fails.

const executeMoneyWrite = vi.fn();
const disputesRetrieve = vi.fn();
const resolveDisputedRecovery = vi.fn();

vi.mock("~/lib/money/execute", () => ({
  executeMoneyWrite: (...args: unknown[]) => executeMoneyWrite(...args),
}));
vi.mock("~/lib/stripe/client", () => ({
  getConnectedStripe: () => ({ disputes: { retrieve: disputesRetrieve } }),
}));
vi.mock("~/lib/stripe/encryption", () => ({
  decryptToken: async () => "sk_test_connected",
}));
vi.mock("~/lib/webhooks/lookups", () => ({
  resolveDisputedRecovery: (...args: unknown[]) => resolveDisputedRecovery(...args),
}));
vi.mock("~/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getDb: (env: { DB: unknown }) => env.DB };
});

const NOW = new Date("2026-08-30T00:00:00.000Z");
const ACCOUNT = "acct_manual";
const CONNECTION = "conn_manual";
const STRIPE_DISPUTE_ID = "dp_manual_1";

/** A committer wired to real SQLite, applying each batch in a real transaction
 *  so a constraint violation rolls the WHOLE batch back exactly as D1's
 *  batch() does. The seen-set is per-committer, standing in for one account's
 *  DO instance. */
function makeCommitter(sqlite: ReturnType<typeof createInMemoryDb>["sqlite"]) {
  const seen = new Set<string>();
  const attempts = { runBatch: 0 };
  const committer = new SerialMoneyCommitter({
    hasSeen: async (key) => seen.has(key),
    markSeen: async (key) => {
      seen.add(key);
    },
    runBatch: async (statements: CompiledStatement[]) => {
      attempts.runBatch += 1;
      const run = sqlite.transaction((stmts: CompiledStatement[]) => {
        for (const s of stmts) sqlite.prepare(s.sql).run(...(s.params as never[]));
      });
      run(statements);
    },
  });
  return { committer, attempts };
}

function compile(batch: unknown[]): CompiledStatement[] {
  return batch.map((item) => (item as { toSQL(): CompiledStatement }).toSQL());
}

async function seed(db: Db) {
  await db.insert(accounts).values({ id: ACCOUNT, name: "Manual Co", createdAt: NOW });
  await db.insert(stripeConnections).values({
    id: CONNECTION,
    accountId: ACCOUNT,
    stripeUserId: "acct_stripe_manual",
    connectedAt: NOW,
    createdAt: NOW,
  });
}

/** The intake batch for one dispute, under whichever claim the caller names. */
function intake(db: Db, claim: WebhookClaimInput, disputeRowId: string) {
  return buildDisputeIntakeBatch(db, {
    claim,
    disputeId: disputeRowId,
    accountId: ACCOUNT,
    stripeConnectionId: CONNECTION,
    stripeDisputeId: STRIPE_DISPUTE_ID,
    stripeChargeId: "ch_manual_1",
    stripeCustomerId: null,
    customerEmail: null,
    customerName: null,
    amountCents: 4_500,
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
    evidenceDeadline: null,
    createdAt: NOW,
    linkedFailedPaymentId: null,
    evidence: [],
  });
}

const manualClaim: WebhookClaimInput = {
  stripeEventId: manualImportClaimKey(STRIPE_DISPUTE_ID),
  eventType: MANUAL_CLAIM_EVENT_TYPE,
  accountId: ACCOUNT,
  receivedAt: NOW,
  payload: { stripeDisputeId: STRIPE_DISPUTE_ID, source: "manual_import" },
};

describe("the unique backstop", () => {
  it("fires directly on a second row with the same stripe_dispute_id", async () => {
    // Hit the constraint directly: two INSERTs, no batch, no committer.
    const { sqlite, db } = createInMemoryDb();
    await seed(db);
    const insert = (rowId: string) =>
      sqlite
        .prepare(
          "insert into disputes (id, account_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency, reason, status, created_at, state) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          rowId,
          ACCOUNT,
          STRIPE_DISPUTE_ID,
          "ch_1",
          100,
          "usd",
          "general",
          "needs_response",
          0,
          "pending_review",
        );

    insert("dsp_first");
    expect(() => insert("dsp_second")).toThrow(
      /UNIQUE constraint failed: disputes\.stripe_dispute_id/,
    );
  });
});

describe("two imports of one dispute converge on one row", () => {
  async function setup() {
    const fixture = createInMemoryDb();
    await seed(fixture.db);
    return { ...fixture, ...makeCommitter(fixture.sqlite) };
  }

  async function disputeRows(db: Db) {
    return db.select({ id: disputes.id }).from(disputes).where(eq(disputes.accountId, ACCOUNT));
  }

  it("double click: manual then manual", async () => {
    const { db, committer, attempts } = await setup();
    const click = (rowId: string) => ({
      idempotencyKey: manualImportClaimKey(STRIPE_DISPUTE_ID),
      statements: compile(
        intake(
          db,
          { ...manualClaim, stripeEventId: manualImportClaimKey(STRIPE_DISPUTE_ID) },
          rowId,
        ),
      ),
    });

    const first = await committer.commit(click("dsp_click_1"));
    const second = await committer.commit(click("dsp_click_2"));

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(await disputeRows(db)).toHaveLength(1);
    // One row would survive a clock-bearing key too (the unique index rolls the
    // second batch back); only a dispute-id key answers the second click from
    // the seen-set without reaching the database.
    expect(attempts.runBatch).toBe(1);
  });
});

describe("the shared Stripe.Dispute mapping", () => {
  const base = {
    id: STRIPE_DISPUTE_ID,
    charge: "ch_1",
    payment_intent: "pi_1",
    amount: 4_500,
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
    evidence_details: { due_by: 1_800_000_000 },
    created: 1_700_000_000,
  } as unknown as Stripe.Dispute;

  it("reads an expanded charge object as well as a bare id", () => {
    expect(
      disputeIntakeFields(
        { ...base, charge: { id: "ch_expanded" } } as unknown as Stripe.Dispute,
        NOW,
      )?.chargeId,
    ).toBe("ch_expanded");
  });
});

async function envWithConnection(connected: boolean): Promise<Env> {
  const { db } = createInMemoryDb();
  await db.insert(accounts).values({ id: ACCOUNT, name: "Manual Co", createdAt: NOW });
  if (connected) {
    await db.insert(stripeConnections).values({
      id: "conn_1",
      accountId: ACCOUNT,
      stripeUserId: "acct_stripe_manual",
      stripeAccessToken: "encrypted",
      connectedAt: NOW,
      createdAt: NOW,
    });
  }
  return { DB: db } as unknown as Env;
}

beforeEach(() => {
  executeMoneyWrite.mockReset();
  disputesRetrieve.mockReset();
  resolveDisputedRecovery.mockReset();
  resolveDisputedRecovery.mockResolvedValue(null);
  executeMoneyWrite.mockResolvedValue({ applied: true });
});

describe("importDisputeFromStripe", () => {
  it("imports a dispute on this account and keys the write on the dispute id", async () => {
    const env = await envWithConnection(true);
    disputesRetrieve.mockResolvedValue({
      id: "dp_mine",
      charge: "ch_1",
      payment_intent: "pi_1",
      amount: 4_500,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      created: 1_700_000_000,
    });

    const result = await importDisputeFromStripe(env, ACCOUNT, "dp_mine", NOW);

    expect(result).toEqual({ status: "imported", disputeId: expect.any(String) });
    expect(executeMoneyWrite).toHaveBeenCalledTimes(1);
    const write = executeMoneyWrite.mock.calls[0][1] as {
      accountId: string;
      idempotencyKey: string;
    };
    expect(write.accountId).toBe(ACCOUNT);
    expect(write.idempotencyKey).toBe(manualImportClaimKey("dp_mine"));
  });

  it("reports already_imported rather than an error when the write is a no-op", async () => {
    const env = await envWithConnection(true);
    disputesRetrieve.mockResolvedValue({
      id: "dp_mine",
      charge: "ch_1",
      amount: 1,
      currency: "usd",
      reason: "general",
      status: "needs_response",
      created: 1,
    });
    executeMoneyWrite.mockResolvedValue({ applied: false });

    expect(await importDisputeFromStripe(env, ACCOUNT, "dp_mine", NOW)).toEqual({
      status: "already_imported",
    });
  });

  it("404s on another account's dispute id and writes nothing", async () => {
    const env = await envWithConnection(true);
    disputesRetrieve.mockRejectedValue(
      Object.assign(new Error("No such dispute: dp_someone_else"), { code: "resource_missing" }),
    );

    expect(await importDisputeFromStripe(env, ACCOUNT, "dp_someone_else", NOW)).toEqual({
      status: "not_found",
    });
    expect(executeMoneyWrite).not.toHaveBeenCalled();
  });

  it("a Stripe failure that is not a 404 is thrown, never reported as not found", async () => {
    const env = await envWithConnection(true);
    disputesRetrieve.mockRejectedValue(
      Object.assign(new Error("Rate limited"), { statusCode: 429, code: "rate_limit" }),
    );
    await expect(importDisputeFromStripe(env, ACCOUNT, "dp_mine", NOW)).rejects.toThrow(
      "Rate limited",
    );
    expect(executeMoneyWrite).not.toHaveBeenCalled();
  });

  it("refuses a malformed id before it ever reaches Stripe", async () => {
    const env = await envWithConnection(true);
    for (const bad of ["", "ch_123", "dp_", "dp_1; drop table disputes", "evt_1"]) {
      expect(await importDisputeFromStripe(env, ACCOUNT, bad, NOW)).toEqual({
        status: "invalid_id",
      });
    }
    expect(disputesRetrieve).not.toHaveBeenCalled();
    expect(executeMoneyWrite).not.toHaveBeenCalled();
  });

  it("refuses when the account has no live Stripe connection", async () => {
    const env = await envWithConnection(false);
    expect(await importDisputeFromStripe(env, ACCOUNT, "dp_mine", NOW)).toEqual({
      status: "not_connected",
    });
    expect(disputesRetrieve).not.toHaveBeenCalled();
    expect(executeMoneyWrite).not.toHaveBeenCalled();
  });

  it("writes nothing for a dispute carrying no charge", async () => {
    const env = await envWithConnection(true);
    disputesRetrieve.mockResolvedValue({ id: "dp_mine", charge: null, amount: 1, currency: "usd" });
    expect(await importDisputeFromStripe(env, ACCOUNT, "dp_mine", NOW)).toEqual({
      status: "not_found",
    });
    expect(executeMoneyWrite).not.toHaveBeenCalled();
  });
});
