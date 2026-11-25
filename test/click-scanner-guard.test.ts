import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import {
  findAttributionSignals,
  isBillableAttribution,
  resolveAttribution,
} from "~/lib/recovery/attribution";

import { createInMemoryDb, inMemoryMoneyWriter } from "./helpers/inmemory-db";

// A click faster than CLICK_SUSPECT_MIN_SECONDS after the send (a link scanner) is recorded but can never bill.

const ACCOUNT = "acct_scan";
const PAYMENT = "fp_scan";
const STEP = "step_scan";

const SENT_AT = new Date("2026-08-20T12:00:00.000Z");
const RECOVERED_AT = new Date("2026-08-21T12:00:00.000Z");

const harness = vi.hoisted(() => ({
  db: null as unknown,
  sqlite: null as unknown,
  now: new Date(),
}));
const ENV = {
  MONEY_WRITER: inMemoryMoneyWriter(() => harness.sqlite as never).binding,
} as unknown as Env;

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

/** Drive the real recorder at a chosen instant by moving the clock. */
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

describe("a click too fast to be a person", () => {
  it("and it cannot attribute the recovery, so it never bills", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 2_000));

    const result = await attribution(db);
    expect(result).toEqual({ kind: "stripe_baseline", ref: null });
    expect(isBillableAttribution(result.kind)).toBe(false);
  });

  it("exactly 60 seconds is not suspect", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 60_000));
    expect((await stepRow(db)).clickSuspectReason).toBeNull();
  });
});
