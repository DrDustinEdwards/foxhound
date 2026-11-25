import { buildRecoverBatch } from "~/lib/webhooks/batches";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { Db, MoneyWriteBatch } from "~/db";
import { accounts, failedPayments, recoveredPayments, recoverySteps } from "~/db/schema";
import { MANUAL_ATTRIBUTION_KIND } from "~/lib/constants";
import { SerialMoneyCommitter } from "~/lib/money/serializer";
import { buildMarkRecoveredBatch } from "~/lib/recovery/manual-action-batches.server";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// Mark as recovered enters through the spine's own recorder; exactly-once is inherited from the outcomes
// idempotency key. Real in-memory SQLite with the committed migrations.

const now = new Date("2026-08-13T00:00:00.000Z");

function seed(opts: { status?: string; steps?: number } = {}) {
  const { sqlite, db } = createInMemoryDb();
  runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Acme" }));
  runStatement(
    sqlite,
    db.insert(failedPayments).values({
      id: "fp_1",
      accountId: "acc_1",
      stripeEventId: "evt_1",
      stripeInvoiceId: "in_1",
      stripeCustomerId: "cus_1",
      customerEmail: "customer@example.com",
      amountCents: 4200,
      currency: "usd",
      declineCategory: "soft",
      status: opts.status ?? "active",
      detectedAt: now,
    }),
  );
  for (let i = 0; i < (opts.steps ?? 0); i++) {
    runStatement(
      sqlite,
      db.insert(recoverySteps).values({
        id: `step_${i}`,
        accountId: "acc_1",
        failedPaymentId: "fp_1",
        stepType: "email_day1",
        scheduledAt: now,
        attemptCount: 0,
      }),
    );
  }
  return { sqlite, db };
}

/** The real committer with in-memory deps, so the unique-constraint backstop is the production one. */
function committerFor(sqlite: Database.Database, db: Db) {
  const seen = new Set<string>();
  const committer = new SerialMoneyCommitter({
    hasSeen: async (key) => seen.has(key),
    markSeen: async (key) => {
      seen.add(key);
    },
    runBatch: async (statements) => {
      // One transaction, all or nothing, exactly as D1's batch() behaves.
      sqlite.transaction(() => {
        for (const s of statements) sqlite.prepare(s.sql).run(...(s.params as never[]));
      })();
    },
  });
  return (key: string, build: (d: Db) => MoneyWriteBatch) =>
    committer.commit({
      idempotencyKey: key,
      statements: build(db).map((item) => {
        const { sql, params } = (
          item as unknown as { toSQL(): { sql: string; params: unknown[] } }
        ).toSQL();
        return { sql, params };
      }),
    });
}

const markRecoveredBatch = (db: Db) =>
  buildMarkRecoveredBatch(db, {
    accountId: "acc_1",
    failedPaymentId: "fp_1",
    amountCents: 4200,
    currency: "usd",
    now,
  });

/** The webhook's own recording of the same payment, for the both-orders race:
 *  its real batch, claim and conditional status flip included. */
const webhookRecoveryBatch = (db: Db) =>
  buildRecoverBatch(db, {
    claim: {
      stripeEventId: "evt_fp_1",
      eventType: "invoice.payment_succeeded",
      receivedAt: now,
      accountId: "acc_1",
      payload: { id: "evt_fp_1" },
    },
    accountId: "acc_1",
    failedPaymentId: "fp_1",
    amountPaidCents: 4200,
    currency: "usd",
    recoveredAt: now,
    attribution: { kind: "foxhound_retry", ref: "step_x" },
    recoveredByStepId: null,
    recoveryMethod: "foxhound_retry",
    idempotencyKey: "fp_1",
  }) as MoneyWriteBatch;

const feeRows = (sqlite: Database.Database) =>
  sqlite
    .prepare("select attribution_kind, recovery_method, attributed_at from recovered_payments")
    .all() as { attribution_kind: string; recovery_method: string; attributed_at: number | null }[];

describe("mark recovered: the schema accepts the manual kind", () => {
  it("the CHECK constraint admits 'manual' after migration 0014", () => {
    const { sqlite, db } = seed();
    expect(() =>
      runStatement(
        sqlite,
        db.insert(recoveredPayments).values({
          id: "rp_1",
          accountId: "acc_1",
          failedPaymentId: "fp_1",
          recoveredAt: now,
          amountCents: 4200,
          currency: "usd",
          recoveryMethod: MANUAL_ATTRIBUTION_KIND,
          attributionKind: MANUAL_ATTRIBUTION_KIND,
        }),
      ),
    ).not.toThrow();
  });

  it("a bogus kind is still refused", () => {
    const { sqlite } = seed();
    expect(() =>
      sqlite
        .prepare(
          "insert into recovered_payments (id, failed_payment_id, recovered_at, amount_cents, currency, recovery_method, account_id, attribution_kind) values ('rp_x','fp_1',0,1,'usd','x','acc_1','not_a_kind')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});

describe("mark recovered: enters through the spine, never as a second writer", () => {
  it("records the fee row and the moat row as one atomic pair, with the manual kind", async () => {
    const { sqlite, db } = seed({ steps: 2 });
    const commit = committerFor(sqlite, db);

    const res = await commit("manual:mark_recovered:fp_1", markRecoveredBatch);
    expect(res.applied).toBe(true);

    expect(feeRows(sqlite)).toEqual([
      {
        attribution_kind: "manual",
        recovery_method: "manual",
        attributed_at: null,
      },
    ]);

    const outcome = sqlite
      .prepare("select idempotency_key, attribution_kind, outcome, product from outcomes")
      .all() as {
      idempotency_key: string;
      attribution_kind: string;
      outcome: string;
      product: string;
    }[];
    expect(outcome).toHaveLength(1);
    expect(outcome[0].idempotency_key).toBe("recovery:fp_1");
    expect(outcome[0].attribution_kind).toBe("manual");
    expect(outcome[0].product).toBe("recovery");

    const payment = sqlite
      .prepare("select status, resolved_at from failed_payments where id='fp_1'")
      .get() as {
      status: string;
      resolved_at: number | null;
    };
    expect(payment.status).toBe("recovered");
    expect(payment.resolved_at).toBe(now.getTime());

    const steps = sqlite.prepare("select result from recovery_steps").all() as { result: string }[];
    expect(steps.map((s) => s.result)).toEqual(["cancelled", "cancelled"]);
  });
});

describe("mark recovered: exactly once, inherited from the outcomes key", () => {
  it("a second identical submit records exactly ONE recovery", async () => {
    const { sqlite, db } = seed();
    const commit = committerFor(sqlite, db);

    const first = await commit("manual:mark_recovered:fp_1", markRecoveredBatch);
    const second = await commit("manual:mark_recovered:fp_1", markRecoveredBatch);

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(feeRows(sqlite)).toHaveLength(1);
  });

  it("BOTH ORDERS race the webhook to exactly one fee row: merchant first", async () => {
    const { sqlite, db } = seed();
    const commit = committerFor(sqlite, db);

    const merchant = await commit("manual:mark_recovered:fp_1", markRecoveredBatch);
    // The webhook carries a different DO key; only the shared outcomes key can stop it.
    const webhook = await commit("stripe_evt_123", webhookRecoveryBatch);

    expect(merchant.applied).toBe(true);
    expect(webhook.applied).toBe(false);
    const rows = feeRows(sqlite);
    expect(rows).toHaveLength(1);
    expect(rows[0].attribution_kind).toBe("manual");
  });

  it("BOTH ORDERS race the webhook to exactly one fee row: webhook first", async () => {
    const { sqlite, db } = seed();
    const commit = committerFor(sqlite, db);

    const webhook = await commit("stripe_evt_123", webhookRecoveryBatch);
    const merchant = await commit("manual:mark_recovered:fp_1", markRecoveredBatch);

    expect(webhook.applied).toBe(true);
    expect(merchant.applied).toBe(false);
    const rows = feeRows(sqlite);
    expect(rows).toHaveLength(1);
    // A manual click cannot downgrade a Foxhound-attributed recovery.
    expect(rows[0].attribution_kind).toBe("foxhound_retry");
    expect(rows[0].attributed_at).toBe(now.getTime());
  });
});

describe("mark recovered: the dispatcher gates", () => {
  it("the manual kind is absent from the billable allow-list", async () => {
    const { BILLABLE_ATTRIBUTION_KINDS } = await import("~/lib/constants");
    expect([...BILLABLE_ATTRIBUTION_KINDS]).not.toContain(MANUAL_ATTRIBUTION_KIND);
  });
});
