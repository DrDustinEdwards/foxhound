import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import { EMAIL_ENGAGEMENT_WINDOW_DAYS, EMAIL_ENGAGEMENT_WINDOW_MS } from "~/lib/constants";
import {
  findAttributionSignals,
  isBillableAttribution,
  resolveAttribution,
} from "~/lib/recovery/attribution";

import { createInMemoryDb } from "./helpers/inmemory-db";

// RULING 377(2): `email_engaged` NEEDED A WINDOW, AND AN ORDER.
//
// The rule was "any step on this payment has clicked_at set", with no window and
// no ordering. That is legacy's rule verbatim, and legacy got away with it by
// bounding the RECOVERY instead: its handlePaymentSucceeded requires
// status='active' and its day-30 sweep flips the row, so a late payment recorded
// nothing at all. 284 deliberately widened Foxhound so late recoveries DO
// record. It never ruled that a months-old click was their cause, and its plant
// at cron-exhausted-sequences.test.ts asserted `email_engaged` across a 43-day
// gap only because nothing else had been decided. That plant is flipped;
// parity/REVERSALS.md carries it as 377(a).
//
// TWO HALVES, EACH WITH ITS OWN FAILURE MODE. A click AFTER the payment cannot
// have caused it: that is a customer tidying an inbox, and billing it charges a
// merchant 20% for their own customer's housekeeping. A click long BEFORE is
// the 284 case: the recovery is real, and Foxhound's email is not why.
//
// These drive real SQL through the same read webhooks/process.ts performs.

const ACCOUNT = "acct_window";
const PAYMENT = "fp_window";

const RECOVERED_AT = new Date("2026-08-20T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function seedWithClick(clickedAt: Date | null) {
  const { db } = createInMemoryDb();
  await db.insert(accounts).values({ id: ACCOUNT, name: "Window Co", createdAt: RECOVERED_AT });
  await db.insert(failedPayments).values({
    id: PAYMENT,
    accountId: ACCOUNT,
    stripeEventId: "evt_window",
    stripeInvoiceId: "in_window",
    stripeCustomerId: "cus_window",
    customerEmail: "payer@example.com",
    amountCents: 10_000,
    currency: "usd",
    declineCategory: "soft",
    status: "active",
    detectedAt: new Date(RECOVERED_AT.getTime() - 60 * DAY),
  });
  await db.insert(recoverySteps).values({
    id: "step_email",
    failedPaymentId: PAYMENT,
    accountId: ACCOUNT,
    stepType: "email_day1",
    stepNumber: 1,
    scheduledAt: new Date(RECOVERED_AT.getTime() - 59 * DAY),
    executedAt: new Date(RECOVERED_AT.getTime() - 59 * DAY),
    result: "email_sent",
    clickedAt,
  });
  return db;
}

/** The exact read the webhook performs, then the real resolution. */
async function attributionFor(db: Awaited<ReturnType<typeof seedWithClick>>, recoveredAt: Date) {
  const steps = await db
    .select({
      id: recoverySteps.id,
      stepType: recoverySteps.stepType,
      result: recoverySteps.result,
      clickedAt: recoverySteps.clickedAt,
    })
    .from(recoverySteps)
    .where(eq(recoverySteps.failedPaymentId, PAYMENT));
  return resolveAttribution(findAttributionSignals(steps, recoveredAt));
}

describe("the engagement window is 14 days, and the click must precede the recovery", () => {
  it("the constant is 14 days, stated once and derived in ms", () => {
    expect(EMAIL_ENGAGEMENT_WINDOW_DAYS).toBe(14);
    expect(EMAIL_ENGAGEMENT_WINDOW_MS).toBe(14 * DAY);
  });

  it("CONTROL: a click one day before the recovery is billable engagement", async () => {
    const db = await seedWithClick(new Date(RECOVERED_AT.getTime() - 1 * DAY));
    const attribution = await attributionFor(db, RECOVERED_AT);

    expect(attribution).toEqual({ kind: "email_engaged", ref: "step_email" });
    expect(isBillableAttribution(attribution.kind)).toBe(true);
  });

  it("a click 43 days before records as the free baseline, which is the 284 case", async () => {
    // The exact gap the flipped 284 plant carries: clicked 2026-06-27, paid
    // 2026-08-09. The recovery still records; it is simply not ours.
    const db = await seedWithClick(new Date(RECOVERED_AT.getTime() - 43 * DAY));
    const attribution = await attributionFor(db, RECOVERED_AT);

    expect(attribution).toEqual({ kind: "stripe_baseline", ref: null });
    expect(isBillableAttribution(attribution.kind)).toBe(false);
  });

  it("a click AFTER the payment is never the cause of it", async () => {
    const db = await seedWithClick(new Date(RECOVERED_AT.getTime() + 1 * DAY));
    const attribution = await attributionFor(db, RECOVERED_AT);

    expect(attribution).toEqual({ kind: "stripe_baseline", ref: null });
  });

  it("a click at the exact instant of the payment does not count, because it did not precede it", async () => {
    const db = await seedWithClick(RECOVERED_AT);
    expect(await attributionFor(db, RECOVERED_AT)).toEqual({ kind: "stripe_baseline", ref: null });
  });

  // THE BOUNDARY, BOTH SIDES. A window asserted only in the middle is a window
  // whose edge nobody has measured.
  it("exactly 14 days before is INSIDE the window", async () => {
    const db = await seedWithClick(new Date(RECOVERED_AT.getTime() - EMAIL_ENGAGEMENT_WINDOW_MS));
    expect(await attributionFor(db, RECOVERED_AT)).toEqual({
      kind: "email_engaged",
      ref: "step_email",
    });
  });

  it("one millisecond older than 14 days is OUTSIDE it", async () => {
    const db = await seedWithClick(
      new Date(RECOVERED_AT.getTime() - EMAIL_ENGAGEMENT_WINDOW_MS - 1),
    );
    expect(await attributionFor(db, RECOVERED_AT)).toEqual({ kind: "stripe_baseline", ref: null });
  });

  it("one millisecond before the payment is INSIDE, so the boundary is not off by a tick", async () => {
    const db = await seedWithClick(new Date(RECOVERED_AT.getTime() - 1));
    expect(await attributionFor(db, RECOVERED_AT)).toEqual({
      kind: "email_engaged",
      ref: "step_email",
    });
  });

  it("no click at all is the baseline, unchanged", async () => {
    const db = await seedWithClick(null);
    expect(await attributionFor(db, RECOVERED_AT)).toEqual({ kind: "stripe_baseline", ref: null });
  });
});

describe("the window and the ordering rule compose", () => {
  it("a stale click plus a fresh one attributes to the FRESH one", async () => {
    const db = await seedWithClick(new Date(RECOVERED_AT.getTime() - 43 * DAY));
    await db.insert(recoverySteps).values({
      id: "step_recent",
      failedPaymentId: PAYMENT,
      accountId: ACCOUNT,
      stepType: "email_day7",
      stepNumber: 2,
      scheduledAt: new Date(RECOVERED_AT.getTime() - 3 * DAY),
      executedAt: new Date(RECOVERED_AT.getTime() - 3 * DAY),
      result: "email_sent",
      clickedAt: new Date(RECOVERED_AT.getTime() - 2 * DAY),
    });

    expect(await attributionFor(db, RECOVERED_AT)).toEqual({
      kind: "email_engaged",
      ref: "step_recent",
    });
  });

  it("a FRESH click after the payment plus a stale one before it attributes to neither", async () => {
    // The composition that a naive "latest click wins" gets wrong: the newest
    // click is disqualified for being after the payment, and falling back to
    // the older one would resurrect exactly the stale-click billing this rules
    // out. Both are excluded, so the recovery is free.
    const db = await seedWithClick(new Date(RECOVERED_AT.getTime() - 43 * DAY));
    await db.insert(recoverySteps).values({
      id: "step_after",
      failedPaymentId: PAYMENT,
      accountId: ACCOUNT,
      stepType: "email_day7",
      stepNumber: 2,
      scheduledAt: new Date(RECOVERED_AT.getTime() - 3 * DAY),
      executedAt: new Date(RECOVERED_AT.getTime() - 3 * DAY),
      result: "email_sent",
      clickedAt: new Date(RECOVERED_AT.getTime() + 1 * DAY),
    });

    expect(await attributionFor(db, RECOVERED_AT)).toEqual({ kind: "stripe_baseline", ref: null });
  });

  it("a succeeded retry still outranks a perfectly good click", async () => {
    const db = await seedWithClick(new Date(RECOVERED_AT.getTime() - 1 * DAY));
    await db.insert(recoverySteps).values({
      id: "step_retry",
      failedPaymentId: PAYMENT,
      accountId: ACCOUNT,
      stepType: "retry_early",
      stepNumber: 2,
      scheduledAt: new Date(RECOVERED_AT.getTime() - 2 * DAY),
      executedAt: new Date(RECOVERED_AT.getTime() - 2 * DAY),
      result: "retry_succeeded",
    });

    expect(await attributionFor(db, RECOVERED_AT)).toEqual({
      kind: "foxhound_retry",
      ref: "step_retry",
    });
  });
});
