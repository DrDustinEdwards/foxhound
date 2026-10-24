import { readFileSync } from "node:fs";


import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import {
  WINBACK_PRIORITY_ACTION,
} from "~/lib/constants";
import { buildInvoluntaryStopBatch } from "~/lib/webhooks/batches";

import { createInMemoryDb, runStatement } from "./helpers/inmemory-db";

// RULING 291: the schedule alignment, the entitlement gate on the aligned base,
// and the involuntary flip through 265's RATIFIED transition.
//
// Legacy's gate, quoted:
//   let step1OffsetHours = WIN_BACK_SCHEDULE[0].offsetHours
//   ... .from('account_products').eq('product','intelligence').eq('status','active')
//   if (intelligenceProduct) {
//     ... if (recommendation !== 'winback_priority') { step1OffsetHours = 4 }
//   }
// So the gate DELAYS the unflagged from 1h to 4h. It is only coherent because
// 291 aligned the base to legacy's 1h; on the old 24h base a literal 4 would
// have ACCELERATED the unflagged, inverting the mechanism.

const now = new Date("2026-08-14T00:00:00.000Z");
const PROCESS = ["process", "lookups", "recovery-handlers", "dispute-handlers", "winback-handlers"]
  .map((f) => readFileSync(`app/lib/webhooks/${f}.ts`, "utf8"))
  .join("\n");


describe("291 B: the gate delays the UNFLAGGED, on the aligned base", () => {

  it("the gate reads the LIVE capability and legacy's value (292)", () => {
    // 292's semantic port: the STORAGE moved to the live entitlement, the value
    // and the direction stayed legacy's. The vestigial table is gone from this
    // file entirely, so a revert cannot hide in a leftover import.
    expect(PROCESS).toContain("isIntelligenceEntitled(db, accountId)");
    expect(PROCESS).not.toContain("accountProducts");
    expect(PROCESS).toContain("recommendation === WINBACK_PRIORITY_ACTION");
    expect(WINBACK_PRIORITY_ACTION).toBe("winback_priority");
  });
});

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
