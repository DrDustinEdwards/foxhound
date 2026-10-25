import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import {
  CLICK_SUSPECT_MIN_SECONDS,
} from "~/lib/constants";
import { findAttributionSignals, isBillableAttribution, resolveAttribution } from "~/lib/recovery/attribution";

import { createInMemoryDb, inMemoryMoneyWriter } from "./helpers/inmemory-db";

// RULING 377(4), PHASE ONE: A CLICK IS NOT EVIDENCE OF A PERSON.
//
// The walk behind 377(4) found the click guard reads four things and none of
// them separates a scanner from a human. IP is persisted nowhere,
// `email_clicked_count` and `time_to_open_minutes` have zero writers, and an
// enterprise link scanner (SafeLinks, Proofpoint, Mimecast) presents a full
// browser user agent, so 369's named-bot list walks straight past it. One
// scanner GET made every later recovery of that payment `email_engaged`, which
// bills the merchant 20% for a fetch their own security vendor performed.
//
// Two cheap tests ship here. The gap between `executed_at` and `clicked_at`,
// which the schema has always stored and nothing ever read; and an invisible
// honeypot link that only a client following every link in the message can
// fetch. NEITHER MAKES A CLICK MONEY-GRADE, and that is stated rather than
// implied: they remove a known class of false positives and nothing more.
//
// THE CLICK IS STILL RECORDED EITHER WAY. Suppressing it would make a scanner
// fetch indistinguishable from a customer who never engaged, and the merchant
// would lose the evidence. What changes is that it can never bill.

const ACCOUNT = "acct_scan";
const PAYMENT = "fp_scan";
const STEP = "step_scan";

const SENT_AT = new Date("2026-08-20T12:00:00.000Z");
const RECOVERED_AT = new Date("2026-08-21T12:00:00.000Z");

const harness = vi.hoisted(() => ({ db: null as unknown, sqlite: null as unknown, now: new Date() }));
const ENV = { MONEY_WRITER: inMemoryMoneyWriter(() => harness.sqlite as never).binding } as unknown as Env;

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { recordClick } = await import("~/lib/engagement/record");

async function seed() {
  const { db, sqlite } = createInMemoryDb();
  harness.db = db;
  harness.sqlite = sqlite;
  await db.insert(accounts).values({ id: ACCOUNT, name: "Scan Co", createdAt: SENT_AT });
  await db.insert(failedPayments).values({
    id: PAYMENT,
    accountId: ACCOUNT,
    stripeEventId: "evt_scan",
    stripeInvoiceId: "in_scan",
    stripeCustomerId: "cus_scan",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "active",
    detectedAt: SENT_AT,
  });
  await db.insert(recoverySteps).values({
    id: STEP,
    failedPaymentId: PAYMENT,
    accountId: ACCOUNT,
    stepType: "email_day1",
    stepNumber: 1,
    scheduledAt: SENT_AT,
    executedAt: SENT_AT,
    result: "email_sent",
  });
  return db;
}

/** Drive the REAL recorder at a chosen instant, by moving the clock rather than
 *  by writing the column the code under test is supposed to compute. */
async function clickAt(instant: Date) {
  vi.setSystemTime(instant);
  try {
    await recordClick(
      ENV,
      { stepId: STEP, accountId: ACCOUNT, kind: "click", url: "https://merchant.example/pay" },
      { automated: false },
    );
  } finally {
    vi.useRealTimers();
  }
}

async function stepRow(db: Awaited<ReturnType<typeof seed>>) {
  const [row] = await db.select().from(recoverySteps).where(eq(recoverySteps.id, STEP));
  return row;
}

async function attribution(db: Awaited<ReturnType<typeof seed>>) {
  const steps = await db
    .select({
      id: recoverySteps.id,
      stepType: recoverySteps.stepType,
      result: recoverySteps.result,
      clickedAt: recoverySteps.clickedAt,
      clickSuspectReason: recoverySteps.clickSuspectReason,
    })
    .from(recoverySteps)
    .where(eq(recoverySteps.failedPaymentId, PAYMENT));
  return resolveAttribution(findAttributionSignals(steps, RECOVERED_AT));
}

describe("trigger one: a click too fast to be a person", () => {
  it("the threshold is 60 seconds", () => {
    expect(CLICK_SUSPECT_MIN_SECONDS).toBe(60);
  });

  it("and it cannot attribute the recovery, so it never bills", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 2_000));

    const result = await attribution(db);
    expect(result).toEqual({ kind: "stripe_baseline", ref: null });
    expect(isBillableAttribution(result.kind)).toBe(false);
  });

  // Both sides of the boundary, because a threshold asserted on one side has an
  // edge nobody measured.
  it("exactly 60 seconds is NOT suspect", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 60_000));
    expect((await stepRow(db)).clickSuspectReason).toBeNull();
  });
});
