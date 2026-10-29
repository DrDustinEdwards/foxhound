import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { buildInvoluntaryStopBatch } from "~/lib/webhooks/batches";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// RULING 291: the involuntary flip through 265's RATIFIED transition. The
// win-back gate itself is driven end to end in winback-gate.test.ts.

const now = new Date("2026-08-14T00:00:00.000Z");

describe("291 C: the involuntary flip goes through 265's ratified transition", () => {
  function seedActive(ids: string[]) {
    const { sqlite, db } = createInMemoryDb();
    runStatement(sqlite, db.insert(accounts).values({ id: "acc_1", name: "Mine" }));
    ids.forEach((id, i) => {
      runStatement(
        sqlite,
        db.insert(failedPayments).values({
          id,
          accountId: "acc_1",
          stripeEventId: `evt_${id}`,
          stripeInvoiceId: `in_${id}`,
          stripeCustomerId: "cus_1",
          customerEmail: "c@example.com",
          amountCents: 1000,
          currency: "usd",
          declineCategory: "soft",
          status: "active",
          detectedAt: now,
        }),
      );
      runStatement(
        sqlite,
        db.insert(recoverySteps).values({
          id: `step_${id}_${i}`,
          failedPaymentId: id,
          accountId: "acc_1",
          stepType: "email_1",
          stepNumber: 1,
          scheduledAt: now,
        }),
      );
    });
    return { sqlite, db };
  }

  function commit(sqlite: ReturnType<typeof createInMemoryDb>["sqlite"], batch: unknown[]) {
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

  const claim = {
    stripeEventId: "evt_sub",
    eventType: "customer.subscription.deleted",
    receivedAt: now,
    accountId: "acc_1",
    payload: {},
  };

  it("stops EVERY active recovery for the customer and cancels their steps", () => {
    const { sqlite, db } = seedActive(["fp_a", "fp_b"]);
    expect(
      commit(
        sqlite,
        buildInvoluntaryStopBatch(db, {
          claim,
          accountId: "acc_1",
          failedPaymentIds: ["fp_a", "fp_b"],
          now,
        }),
      ).applied,
    ).toBe(true);
    const statuses = sqlite
      .prepare("select status from failed_payments order by id")
      .all() as { status: string }[];
    expect(statuses.map((s) => s.status)).toEqual(["cancelled", "cancelled"]);
    const results = sqlite
      .prepare("select result from recovery_steps order by id")
      .all() as { result: string | null }[];
    expect(results.every((r) => r.result === "cancelled")).toBe(true);
  });

  it("a REDELIVERED stop does not double-resolve", () => {
    // Both-sides shape: the first stop applies, the second finds nothing active,
    // so the claim takes zero rows and resolved_at is not moved a second time.
    const { sqlite, db } = seedActive(["fp_x"]);
    commit(
      sqlite,
      buildInvoluntaryStopBatch(db, { claim, accountId: "acc_1", failedPaymentIds: ["fp_x"], now }),
    );
    const first = sqlite.prepare("select resolved_at from failed_payments where id = ?").get("fp_x") as {
      resolved_at: number;
    };
    const later = new Date(now.getTime() + 90 * 60 * 1000);
    commit(
      sqlite,
      buildInvoluntaryStopBatch(db, {
        claim: { ...claim, stripeEventId: "evt_sub_2" },
        accountId: "acc_1",
        failedPaymentIds: ["fp_x"],
        now: later,
      }),
    );
    const second = sqlite.prepare("select resolved_at from failed_payments where id = ?").get("fp_x") as {
      resolved_at: number;
    };
    expect(second.resolved_at).toBe(first.resolved_at);
  });
});
