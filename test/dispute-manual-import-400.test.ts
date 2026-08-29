import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { accounts, disputes, stripeConnections, webhookEvents, type Db } from "~/db";
import {
  MANUAL_CLAIM_EVENT_TYPE,
  MANUAL_CLAIM_PREFIX,
  manualImportClaimKey,
} from "~/lib/disputes/manual-import.server";
import { disputeIntakeFields, isStripeDisputeId } from "~/lib/disputes/stripe-dispute";
import {
  SerialMoneyCommitter,
  isUniqueConstraintError,
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
// asserted here against the MIGRATION rather than against app/db/schema.ts,
// because 386's rule is that the fixture builds from migrations and a schema.ts
// assertion proves nothing about what actually runs.
//
// THE CONVERGENCE TESTS RUN AGAINST REAL SQLITE, not a hand-written fake D1.
// createInMemoryDb applies the committed migrations verbatim, so the unique
// indexes below are the real ones, the error strings are SQLite's own, and
// isUniqueConstraintError is matching what it will match in production. The
// real SerialMoneyCommitter drives them, so the batch atomicity and the
// applied=false path are the shipped code rather than a restatement of it.

const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle/migrations", import.meta.url));

function migrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8"))
    .join("\n");
}

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

const webhookClaim: WebhookClaimInput = {
  stripeEventId: "evt_dispute_created_1",
  eventType: "charge.dispute.created",
  accountId: ACCOUNT,
  receivedAt: NOW,
  payload: {},
};

describe("the manual-import claim key", () => {
  it("is the dispute id and nothing else, with no clock in it", () => {
    // THE ASSERTION THE DOUBLE-CLICK CASE RESTS ON. Legacy's key is
    // `sync_${Date.now()}`, fresh per click, so two clicks never collide and the
    // DO can never collapse them. Pinning the exact string is what makes a
    // Date.now (or a crypto.randomUUID, or an account prefix) fail here
    // immediately rather than only in the harder integration case below.
    expect(manualImportClaimKey(STRIPE_DISPUTE_ID)).toBe(`manual_dispute:${STRIPE_DISPUTE_ID}`);
    expect(MANUAL_CLAIM_PREFIX).toBe("manual_dispute:");
  });

  it("is stable across calls", () => {
    expect(manualImportClaimKey("dp_x")).toBe(manualImportClaimKey("dp_x"));
  });

  it("differs per dispute, so two real disputes do not collapse into one", () => {
    expect(manualImportClaimKey("dp_a")).not.toBe(manualImportClaimKey("dp_b"));
  });

  it("does not impersonate a Stripe event in the claim row", () => {
    expect(MANUAL_CLAIM_EVENT_TYPE).not.toMatch(/^charge\./);
    expect(MANUAL_CLAIM_EVENT_TYPE).toContain("manual");
  });
});

describe("the unique backstop exists in the SQL the fixture runs (381, 386)", () => {
  it("is created by a committed migration, not merely declared in schema.ts", () => {
    const sql = migrationSql();
    expect(sql.length).toBeGreaterThan(1000);
    expect(sql).toContain(
      "CREATE UNIQUE INDEX `disputes_stripe_dispute_uq` ON `disputes` (`stripe_dispute_id`)",
    );
  });

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

  it("is the error shape the serializer reads as applied=false", () => {
    // The two halves have to agree or the backstop throws a 500 at the merchant
    // instead of converging. Asserted against SQLite's real message.
    expect(
      isUniqueConstraintError(new Error("UNIQUE constraint failed: disputes.stripe_dispute_id")),
    ).toBe(true);
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

  it("manual first, then the webhook event arrives", async () => {
    // The claim keys DIFFER here, so the collapse cannot come from the claim.
    // It comes from disputes_stripe_dispute_uq rolling the whole second batch
    // back, which is exactly the case 400 added the backstop for.
    const { db, committer } = await setup();
    const manual = await committer.commit({
      idempotencyKey: manualImportClaimKey(STRIPE_DISPUTE_ID),
      statements: compile(intake(db, manualClaim, "dsp_manual")),
    });
    const webhook = await committer.commit({
      idempotencyKey: webhookClaim.stripeEventId,
      statements: compile(intake(db, webhookClaim, "dsp_webhook")),
    });

    expect(manual.applied).toBe(true);
    expect(webhook.applied).toBe(false);
    const rows = await disputeRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("dsp_manual");

    // The rolled-back batch must leave NOTHING behind, including its claim row.
    const claims = await db
      .select({ id: webhookEvents.stripeEventId })
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, webhookClaim.stripeEventId));
    expect(claims).toHaveLength(0);
  });

  it("webhook first, then the merchant imports it by hand", async () => {
    const { db, committer } = await setup();
    const webhook = await committer.commit({
      idempotencyKey: webhookClaim.stripeEventId,
      statements: compile(intake(db, webhookClaim, "dsp_webhook")),
    });
    const manual = await committer.commit({
      idempotencyKey: manualImportClaimKey(STRIPE_DISPUTE_ID),
      statements: compile(intake(db, manualClaim, "dsp_manual")),
    });

    expect(webhook.applied).toBe(true);
    expect(manual.applied).toBe(false);
    const rows = await disputeRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("dsp_webhook");
  });

  it("two DIFFERENT disputes both land, so the collapse is not indiscriminate", async () => {
    // 383's positive control: an idempotency test that only ever asserts
    // absence is green when nothing writes at all.
    const { db, committer } = await setup();
    const other = buildDisputeIntakeBatch(db, {
      claim: { ...manualClaim, stripeEventId: manualImportClaimKey("dp_manual_2") },
      disputeId: "dsp_other",
      accountId: ACCOUNT,
      stripeConnectionId: CONNECTION,
      stripeDisputeId: "dp_manual_2",
      stripeChargeId: "ch_manual_2",
      stripeCustomerId: null,
      customerEmail: null,
      customerName: null,
      amountCents: 900,
      currency: "usd",
      reason: "general",
      status: "needs_response",
      evidenceDeadline: null,
      createdAt: NOW,
      linkedFailedPaymentId: null,
      evidence: [],
    });

    await committer.commit({
      idempotencyKey: manualImportClaimKey(STRIPE_DISPUTE_ID),
      statements: compile(intake(db, manualClaim, "dsp_one")),
    });
    const second = await committer.commit({
      idempotencyKey: manualImportClaimKey("dp_manual_2"),
      statements: compile(other),
    });

    expect(second.applied).toBe(true);
    expect(await disputeRows(db)).toHaveLength(2);
  });
});

describe("the posted id is validated server-side", () => {
  it("accepts a Stripe dispute id", () => {
    expect(isStripeDisputeId("dp_1NxyzABC")).toBe(true);
  });

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

  it("maps every field the intake writes", () => {
    const fields = disputeIntakeFields(base, NOW);
    expect(fields).toMatchObject({
      stripeDisputeId: STRIPE_DISPUTE_ID,
      chargeId: "ch_1",
      paymentIntentId: "pi_1",
      amountCents: 4_500,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
    });
    expect(fields?.createdAt.toISOString()).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(fields?.evidenceDeadline?.toISOString()).toBe(
      new Date(1_800_000_000 * 1000).toISOString(),
    );
  });

  it("reads an expanded charge object as well as a bare id", () => {
    expect(disputeIntakeFields({ ...base, charge: { id: "ch_expanded" } } as unknown as Stripe.Dispute, NOW)?.chargeId).toBe(
      "ch_expanded",
    );
  });

  it("returns null for a dispute with no charge, the webhook's own ignore", () => {
    expect(disputeIntakeFields({ ...base, charge: null } as unknown as Stripe.Dispute, NOW)).toBeNull();
  });

  it("falls back to the injected now, never to a hidden clock", () => {
    expect(disputeIntakeFields({ ...base, created: undefined } as unknown as Stripe.Dispute, NOW)?.createdAt).toEqual(NOW);
  });
});
