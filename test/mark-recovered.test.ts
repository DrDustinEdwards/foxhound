import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { Db, MoneyWriteBatch } from "~/db";
import { billableRecoveryRowConditions } from "~/db/billable";
import { accounts, failedPayments, recoveredPayments, recoverySteps } from "~/db/schema";
import { MANUAL_ATTRIBUTION_KIND, RECOVERY_MATURITY_MS } from "~/lib/constants";
import { SerialMoneyCommitter } from "~/lib/money/serializer";
import { buildMarkRecoveredBatch } from "~/lib/recovery/manual-action-batches.server";
import { buildRecoveryBatch } from "~/lib/recovery/record-recovery";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// S7 Phase 2 Session E: Mark as recovered, the phase's hardest build per 260.
//
// The load-bearing claim under test is 262 decision five: the manual path enters
// through the spine's OWN recorder rather than becoming a second writer of
// recovered_payments, and its exactly-once guarantee is INHERITED from the
// outcomes idempotency key rather than invented. Everything here runs against a
// real in-memory SQLite with the committed migrations applied, so the CHECK
// constraint and the partial unique index are the actual ones D1 will enforce.

const now = new Date("2026-08-13T00:00:00.000Z");
const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle/migrations", import.meta.url));

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

/**
 * The REAL committer, with in-memory deps. Using SerialMoneyCommitter rather than
 * a hand-rolled runner means the unique-constraint backstop under test is the
 * production one, including its isUniqueConstraintError mapping to applied=false.
 */
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
        const { sql, params } = (item as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
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

/** The webhook's own recording of the same payment, for the both-orders race. */
const webhookRecoveryBatch = (db: Db) =>
  buildRecoveryBatch(db, {
    accountId: "acc_1",
    failedPaymentId: "fp_1",
    amountCents: 4200,
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

  it("and the CHECK is REAL, not decorative: a bogus kind is still refused", () => {
    // Without this the test above could pass on a table with no constraint at all,
    // which is precisely the capability-level check 265 requires.
    const { sqlite } = seed();
    expect(() =>
      sqlite
        .prepare(
          "insert into recovered_payments (id, failed_payment_id, recovered_at, amount_cents, currency, recovery_method, account_id, attribution_kind) values ('rp_x','fp_1',0,1,'usd','x','acc_1','not_a_kind')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("migration 0014 PRESERVES existing rows through its table recreate", () => {
    // 0014 drops and rebuilds recovered_payments (SQLite cannot alter a CHECK), on
    // the fee-bearing table, with billing_line_items holding an inbound FK. Replay
    // the migrations up to 0013, plant a row, then apply 0014 alone.
    const sqlite = new Database(":memory:");
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const upTo13 = files.filter((f) => !f.startsWith("0014"));
    const only14 = files.filter((f) => f.startsWith("0014"));
    expect(only14).toHaveLength(1);
    const apply = (file: string) => {
      for (const stmt of readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8").split("--> statement-breakpoint")) {
        const t = stmt.trim();
        if (t) sqlite.exec(t);
      }
    };
    upTo13.forEach(apply);
    sqlite.prepare("insert into accounts (id, name) values ('acc_1','Acme')").run();
    sqlite
      .prepare(
        "insert into failed_payments (id, account_id, stripe_event_id, stripe_invoice_id, stripe_customer_id, customer_email, amount_cents, currency, decline_category, status, detected_at) values ('fp_1','acc_1','e','i','c','x@y.com',4200,'usd','soft','recovered',0)",
      )
      .run();
    sqlite
      .prepare(
        "insert into recovered_payments (id, failed_payment_id, recovered_at, amount_cents, currency, recovery_method, account_id, attribution_kind, attributed_at) values ('rp_keep','fp_1',123,4200,'usd','foxhound_retry','acc_1','foxhound_retry',123)",
      )
      .run();

    apply(only14[0]);

    const rows = sqlite.prepare("select * from recovered_payments").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("rp_keep");
    expect(rows[0].attribution_kind).toBe("foxhound_retry");
    expect(rows[0].attributed_at).toBe(123);
    expect(rows[0].amount_cents).toBe(4200);
    // The indexes come back too, or every recovery read degrades to a scan.
    const idx = sqlite
      .prepare("select name from sqlite_master where type='index' and tbl_name='recovered_payments'")
      .all() as { name: string }[];
    const names = idx.map((i) => i.name);
    expect(names).toContain("recovered_payments_account_idx");
    expect(names).toContain("recovered_payments_failed_payment_idx");
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
        // NEVER billable: buildRecoveryBatch stamps attributed_at only for a
        // billable kind, so the maturity window can never pick this row up.
        attributed_at: null,
      },
    ]);

    const outcome = sqlite
      .prepare("select idempotency_key, attribution_kind, outcome, product from outcomes")
      .all() as { idempotency_key: string; attribution_kind: string; outcome: string; product: string }[];
    expect(outcome).toHaveLength(1);
    // THE SHARED KEY SPACE: identical to what the webhook writes for this payment.
    expect(outcome[0].idempotency_key).toBe("recovery:fp_1");
    expect(outcome[0].attribution_kind).toBe("manual");
    expect(outcome[0].product).toBe("recovery");

    const payment = sqlite.prepare("select status, resolved_at from failed_payments where id='fp_1'").get() as {
      status: string;
      resolved_at: number | null;
    };
    expect(payment.status).toBe("recovered");
    expect(payment.resolved_at).toBe(now.getTime());

    // Legacy's step three, read from source: unexecuted steps resolve to cancelled.
    const steps = sqlite.prepare("select result from recovery_steps").all() as { result: string }[];
    expect(steps.map((s) => s.result)).toEqual(["cancelled", "cancelled"]);
  });

  it("a manual recovery is NOT billable, while a foxhound_retry one IS", async () => {
    // Paired against a positive control so the assertion cannot pass by returning
    // nothing, which is the failure mode a bare "expect empty" invites.
    const { sqlite, db } = seed();
    const commit = committerFor(sqlite, db);
    await commit("manual:mark_recovered:fp_1", markRecoveredBatch);
    // A matured, attributed control row on the same account.
    const matured = new Date(now.getTime() - RECOVERY_MATURITY_MS - 1);
    runStatement(
      sqlite,
      db.insert(recoveredPayments).values({
        id: "rp_control",
        accountId: "acc_1",
        failedPaymentId: "fp_1",
        recoveredAt: matured,
        amountCents: 999,
        currency: "usd",
        recoveryMethod: "foxhound_retry",
        attributionKind: "foxhound_retry",
        attributedAt: matured,
      }),
    );
    // Age the manual row past maturity too, so maturity cannot be what excludes it.
    runStatement(
      sqlite,
      db
        .update(recoveredPayments)
        .set({ recoveredAt: matured })
        .where(eq(recoveredPayments.attributionKind, MANUAL_ATTRIBUTION_KIND)),
    );

    const billable = await db
      .select({ id: recoveredPayments.id, kind: recoveredPayments.attributionKind })
      .from(recoveredPayments)
      .where(billableRecoveryRowConditions("acc_1", now.getTime()));

    expect(billable.map((r) => r.id)).toEqual(["rp_control"]);
    expect(billable.map((r) => r.kind)).not.toContain(MANUAL_ATTRIBUTION_KIND);
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
    // The webhook arrives after, carrying a DIFFERENT DO key. Only the shared
    // outcomes key can stop it, which is the whole point of deriving that key
    // from the failed payment rather than from the event.
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
    // The webhook's attributed recovery SURVIVES: a merchant click cannot
    // downgrade a real Foxhound-attributed recovery to a free manual one.
    expect(rows[0].attribution_kind).toBe("foxhound_retry");
    expect(rows[0].attributed_at).toBe(now.getTime());
  });
});

describe("mark recovered: the claim shape", () => {
  it("a non-active payment claims ZERO rows and cancels no steps", () => {
    const { sqlite, db } = seed({ status: "cancelled", steps: 1 });
    const batch = markRecoveredBatch(db);

    const claimed = runStatement(sqlite, batch[0]);
    // Statements two and three still run, as they would inside the batch.
    runStatement(sqlite, batch[1]);
    runStatement(sqlite, batch[2]);
    const stepsChanged = runStatement(sqlite, batch[3]);

    expect(claimed).toBe(0);
    // The step cancel is conditioned on the claim's effect, so a lost claim
    // resolves nothing.
    expect(stepsChanged).toBe(0);
    expect(
      (sqlite.prepare("select status from failed_payments where id='fp_1'").get() as { status: string }).status,
    ).toBe("cancelled");
  });
});

describe("mark recovered: the dispatcher gates", () => {
  it("keeps requiring an active payment", async () => {
    const { MANUAL_ACTION_REQUIRES_ACTIVE } = await import("~/lib/recovery/manual-actions.server");
    expect(MANUAL_ACTION_REQUIRES_ACTIVE.mark_recovered).toBe(true);
  });

  it("the manual kind is absent from the billable allow-list", async () => {
    const { BILLABLE_ATTRIBUTION_KINDS } = await import("~/lib/constants");
    expect([...BILLABLE_ATTRIBUTION_KINDS]).not.toContain(MANUAL_ATTRIBUTION_KIND);
  });
});
