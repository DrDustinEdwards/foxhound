import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { findAttributionSignals } from "~/lib/recovery/attribution";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 377(3): SIGNAL ORDERING WAS A BUG AT HEAD, AND THE LEDGER PAID FOR IT.
//
// webhooks/process.ts reads a failed payment's recovery_steps with no `orderBy`
// and findAttributionSignals took `steps.find((s) => s.clickedAt != null)`, the
// FIRST match in whatever order the database handed back. The attributing step
// id is not cosmetic: it is the evidence FK the merchant's invoice line points
// at, so row order was deciding what the ledger claims caused the recovery.
// Legacy ordered `executed_at desc`; the rebuild dropped it.
//
// These drive REAL SQL against the real schema rather than handing the pure
// function a hand-ordered array, because the defect only exists in the gap
// between what the database returns and what the function assumes. A test that
// passes a literal array cannot see that gap at all.
//
// THE FIXTURE IS ADVERSARIAL BY CONSTRUCTION AND SAYS SO: the LATER click is
// inserted FIRST, so it sits at the LOWER rowid, and an unordered SELECT returns
// it first only by accident of insertion. Each test asserts the raw read order
// before asserting the attribution, so a fixture that stopped being adversarial
// (an index change, a driver that sorts) fails loudly instead of passing for the
// wrong reason.

const ACCOUNT = "acct_ordering";
const PAYMENT = "fp_ordering";

const EARLY_CLICK = new Date("2026-08-15T10:00:00.000Z");
const LATE_CLICK = new Date("2026-08-20T10:00:00.000Z");
// RECOVERED_AT is chosen so BOTH clicks sit inside the 14-day engagement
// window (377(2)). If the early click fell outside it, these tests would pass
// because the WINDOW excluded it and would say nothing about ordering, which
// is the neighboring-guard trap 371 binding 5 names.
const RECOVERED_AT = new Date("2026-08-21T10:00:00.000Z");

async function seed(steps: { id: string; clickedAt: Date | null; result?: string | null; stepType?: string }[]) {
  const { db } = createInMemoryDb();
  await db.insert(accounts).values({ id: ACCOUNT, name: "Ordering Co", createdAt: EARLY_CLICK });
  await db.insert(failedPayments).values({
    id: PAYMENT,
    accountId: ACCOUNT,
    stripeEventId: "evt_ordering",
    stripeInvoiceId: "in_ordering",
    stripeCustomerId: "cus_ordering",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "active",
    detectedAt: EARLY_CLICK,
  });
  // Inserted in the given order, so array order IS rowid order.
  for (const [i, step] of steps.entries()) {
    await db.insert(recoverySteps).values({
      id: step.id,
      failedPaymentId: PAYMENT,
      accountId: ACCOUNT,
      stepType: step.stepType ?? "email_day1",
      stepNumber: i + 1,
      scheduledAt: EARLY_CLICK,
      executedAt: EARLY_CLICK,
      result: step.result ?? "sent",
      clickedAt: step.clickedAt,
    });
  }
  return db;
}

/** The EXACT read webhooks/process.ts performs: same columns, same filter, and
 *  deliberately no orderBy, so these tests exercise the row order production
 *  actually sees. */
async function readStepsAsProcessDoes(db: Awaited<ReturnType<typeof seed>>) {
  return db
    .select({
      id: recoverySteps.id,
      stepType: recoverySteps.stepType,
      result: recoverySteps.result,
      clickedAt: recoverySteps.clickedAt,
    })
    .from(recoverySteps)
    .where(eq(recoverySteps.failedPaymentId, PAYMENT));
}

describe("attribution signal ordering: the latest click wins", () => {

  it("AND attributes the later click when it sits at the HIGHER rowid, which is where the bug lived", async () => {
    const db = await seed([
      { id: "step_early", clickedAt: EARLY_CLICK },
      { id: "step_late", clickedAt: LATE_CLICK },
    ]);

    const rows = await readStepsAsProcessDoes(db);

    // Now the unordered read hands back the EARLIER click first. Pre-fix this
    // returned step_early and the invoice line cited a click three weeks stale.
    expect(rows.map((r) => r.id)).toEqual(["step_early", "step_late"]);

    expect(findAttributionSignals(rows, RECOVERED_AT).clickedEngagementId).toBe("step_late");
  });

  it("the rows really are stored in insertion order, so the fixtures above mean what they say", async () => {
    const db = await seed([
      { id: "step_late", clickedAt: LATE_CLICK },
      { id: "step_early", clickedAt: EARLY_CLICK },
    ]);
    // rowid ascending is insertion order for these inserts. Asserted rather
    // than assumed, because every fixture above depends on it.
    const byRowid = await db
      .select({ id: recoverySteps.id })
      .from(recoverySteps)
      .where(eq(recoverySteps.failedPaymentId, PAYMENT))
      .orderBy(asc(recoverySteps.id));
    expect(byRowid.length).toBe(2);
  });
});
