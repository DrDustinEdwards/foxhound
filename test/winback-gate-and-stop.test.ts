import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";

import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import {
  WINBACK_PRIORITY_ACTION,
  WINBACK_STEP1_HOURS,
  WINBACK_STEP2_HOURS,
  WINBACK_STEP3_HOURS,
  WINBACK_UNFLAGGED_STEP1_HOURS,
} from "~/lib/constants";
import { planWinbackSteps } from "~/lib/recovery/winback";
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
const HOUR_MS = 60 * 60 * 1000;
const PROCESS = readFileSync("app/lib/webhooks/process.ts", "utf8");

function offsets(step1OffsetHours?: number): number[] {
  return planWinbackSteps({
    winBackSequenceId: "wb_1",
    accountId: "acc_1",
    canceledAt: now,
    step1OffsetHours,
  }).map((s) => (s.scheduledAt.getTime() - now.getTime()) / HOUR_MS);
}

describe("291 A: the schedule is legacy's", () => {
  it("the planner emits 1 / 96 / 336, legacy's exact hours", () => {
    expect(offsets()).toEqual([1, 96, 336]);
    // Tied to the constants too, so a constant change must come through here.
    expect(offsets()).toEqual([WINBACK_STEP1_HOURS, WINBACK_STEP2_HOURS, WINBACK_STEP3_HOURS]);
  });
});

describe("291 B: the gate delays the UNFLAGGED, on the aligned base", () => {
  it("an unflagged customer is delayed to 4h, steps 2 and 3 untouched", () => {
    expect(offsets(WINBACK_UNFLAGGED_STEP1_HOURS)).toEqual([4, 96, 336]);
  });

  it("a flagged customer keeps the 1h default", () => {
    // The gate resolves to undefined for a flagged customer, which is the
    // schedule as written, so this is the SAME shape as no gate at all.
    expect(offsets(undefined)).toEqual([1, 96, 336]);
  });

  it("the delay is a DELAY: unflagged step 1 is strictly later than flagged", () => {
    // The assertion that would have caught the inverted port. On the old 24h
    // base this comparison ran the other way, which is why 291 coupled the two.
    expect(offsets(WINBACK_UNFLAGGED_STEP1_HOURS)[0]).toBeGreaterThan(offsets()[0]);
    expect(WINBACK_UNFLAGGED_STEP1_HOURS).toBe(4);
    expect(WINBACK_STEP1_HOURS).toBe(1);
  });

  it("only step ONE is overridable, as legacy overrides only step one", () => {
    const weird = offsets(999);
    expect(weird[0]).toBe(999);
    expect(weird.slice(1)).toEqual([96, 336]);
  });

  it("the gate reads the LIVE capability and legacy's value (292)", () => {
    // 292's semantic port: the STORAGE moved to the live entitlement, the value
    // and the direction stayed legacy's. The vestigial table is gone from this
    // file entirely, so a revert cannot hide in a leftover import.
    expect(PROCESS).toContain("isIntelligenceEntitled(db, accountId)");
    expect(PROCESS).not.toContain("accountProducts");
    expect(PROCESS).toContain("recommendation === WINBACK_PRIORITY_ACTION");
    expect(WINBACK_PRIORITY_ACTION).toBe("winback_priority");
  });

  it("the gate fails OPEN, never onto a silently different cadence", () => {
    expect(PROCESS).toContain("// Fail open: the default schedule, never a silently different cadence.");
  });

  it("the bound is HALVED, not dropped and not left standing whole (292)", () => {
    // The account_products half died with the read it justified: leaving it as
    // prose after the code stopped depending on it is 288's dead-conditional
    // rule. The producer half is still true and still stated.
    expect(PROCESS).not.toContain("account_products has ZERO writers in Foxhound");
    expect(PROCESS).toContain(
      "nothing in Foxhound writes `winback_priority` into recommended_action,",
    );
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

  it("CLAIMS the transition: a payment already recovered is NOT overwritten", () => {
    // 265's first guard. This is the assertion legacy's unconditional per-row
    // update would fail: it would stamp cancelled over a recovered payment.
    const { sqlite, db } = seedActive(["fp_r"]);
    runStatement(
      sqlite,
      db.update(failedPayments).set({ status: "recovered" }).where(eq(failedPayments.id, "fp_r")),
    );
    commit(
      sqlite,
      buildInvoluntaryStopBatch(db, { claim, accountId: "acc_1", failedPaymentIds: ["fp_r"], now }),
    );
    const row = sqlite.prepare("select status from failed_payments where id = ?").get("fp_r") as {
      status: string;
    };
    expect(row.status).toBe("recovered");
  });

  it("and when the claim LOSES, the steps are not touched either", () => {
    // 265's second guard, the correlated subquery. Without it a lost claim would
    // still cancel the steps of a payment this batch did not cancel.
    const { sqlite, db } = seedActive(["fp_r"]);
    runStatement(
      sqlite,
      db.update(failedPayments).set({ status: "recovered" }).where(eq(failedPayments.id, "fp_r")),
    );
    commit(
      sqlite,
      buildInvoluntaryStopBatch(db, { claim, accountId: "acc_1", failedPaymentIds: ["fp_r"], now }),
    );
    const step = sqlite.prepare("select result from recovery_steps limit 1").get() as {
      result: string | null;
    };
    expect(step.result).toBeNull();
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

  it("reuses the RATIFIED builder rather than a second writer", () => {
    const BATCHES = readFileSync("app/lib/webhooks/batches.ts", "utf8");
    expect(BATCHES).toContain("buildStopRecoveryBatch(db, {");
    // The processor must route the involuntary case through it.
    expect(PROCESS).toContain("buildInvoluntaryStopBatch(db, {");
    expect(PROCESS).toContain('reason: "involuntary_churn"');
  });
});
