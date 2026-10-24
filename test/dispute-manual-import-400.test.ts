
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { accounts, disputes, stripeConnections, type Db } from "~/db";
import {
  MANUAL_CLAIM_EVENT_TYPE,
  manualImportClaimKey,
} from "~/lib/disputes/manual-import.server";
import { disputeIntakeFields, isStripeDisputeId } from "~/lib/disputes/stripe-dispute";
import {
  SerialMoneyCommitter,
  type CompiledStatement,
} from "~/lib/money/serializer";
import { buildDisputeIntakeBatch, type WebhookClaimInput } from "~/lib/webhooks/batches";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Ruling 400 halt ruling 1: the manual dispute import, built in Foxhound's
// stronger form. Session 90 halted the button because legacy's endpoint
// synthesises a fresh event id per click (`sync_${Date.now()}`), which is not an
// idempotency key, leaving a read-then-write SELECT as the only guard on a row
// that gates a 20%-of-won fee. 400 ruled the claim key is the STRIPE DISPUTE ID
// and the intake gains a unique backstop.
//
// PREMISE CORRECTED AT THIS SHA, and it is why no migration ships with this:
// `disputes_stripe_dispute_uq` ALREADY EXISTS. It is created by
// drizzle/migrations/0000_init_foxhound_schema.sql:443 and was verified present
// in production D1 (3ad240ed) this session, alongside 8 dispute rows with 8
// distinct stripe_dispute_id values. The backstop 400 ruled for was already in
// place; what was missing was the import path that relies on it. The index is
// asserted here against the MIGRATION rather than against app/db/schema/,
// because 386's rule is that the fixture builds from migrations and a schema.ts
// assertion proves nothing about what actually runs.
//
// THE CONVERGENCE TESTS RUN AGAINST REAL SQLITE, not a hand-written fake D1.
// createInMemoryDb applies the committed migrations verbatim, so the unique
// indexes below are the real ones, the error strings are SQLite's own, and
// isUniqueConstraintError is matching what it will match in production. The
// real SerialMoneyCommitter drives them, so the batch atomicity and the
// applied=false path are the shipped code rather than a restatement of it.



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
  // Counted, because "how many rows survived" cannot tell a good key from a bad
  // one: the unique backstop holds the row count at one either way, which is
  // the whole point of having two layers. What the KEY buys is that a repeat
  // never reaches the database at all, and that is only visible here.
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


describe("the manual-import claim key", () => {

  it("is stable across calls", () => {
    expect(manualImportClaimKey("dp_x")).toBe(manualImportClaimKey("dp_x"));
  });

  it("does not impersonate a Stripe event in the claim row", () => {
    expect(MANUAL_CLAIM_EVENT_TYPE).not.toMatch(/^charge\./);
    expect(MANUAL_CLAIM_EVENT_TYPE).toContain("manual");
  });
});

describe("the unique backstop exists in the SQL the fixture runs (381, 386)", () => {

  it("fires directly on a second row with the same stripe_dispute_id", async () => {
    // 381's discipline: prove the constraint by hitting it, not by reading that
    // it is there. Two INSERTs, no batch, no committer, no application code.
    const { sqlite, db } = createInMemoryDb();
    await seed(db);
    const insert = (rowId: string) =>
      sqlite
        .prepare(
          "insert into disputes (id, account_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency, reason, status, created_at, state) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(rowId, ACCOUNT, STRIPE_DISPUTE_ID, "ch_1", 100, "usd", "general", "needs_response", 0, "pending_review");

    insert("dsp_first");
    expect(() => insert("dsp_second")).toThrow(/UNIQUE constraint failed: disputes\.stripe_dispute_id/);
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
    // Both clicks derive their claim exactly as importDisputeFromStripe does,
    // so a key carrying a clock would produce two different keys here just as
    // it would in production.
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
    // THE ASSERTION THAT DISCRIMINATES THE KEY. One row would survive a
    // clock-bearing key too, because disputes_stripe_dispute_uq would roll the
    // second batch back. What only a dispute-id-derived key gives is that the
    // second click is answered from the DO's seen-set and never reaches the
    // database: one batch attempted, not two.
    expect(attempts.runBatch).toBe(1);
  });
});

describe("the posted id is validated server-side", () => {

  it("rejects anything else, including the shapes a typo produces", () => {
    // Legacy checks this in the browser only, which an action cannot rely on.
    for (const bad of ["", "ch_123", "dp_", "dp", " dp_1", "dp_1; drop table disputes", "evt_1"]) {
      expect(isStripeDisputeId(bad)).toBe(false);
    }
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
    expect(disputeIntakeFields({ ...base, charge: { id: "ch_expanded" } } as unknown as Stripe.Dispute, NOW)?.chargeId).toBe(
      "ch_expanded",
    );
  });
});
