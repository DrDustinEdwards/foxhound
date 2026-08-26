import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, failedPayments, recoverySteps } from "~/db/schema";
import {
  CLICK_SUSPECT_HONEYPOT,
  CLICK_SUSPECT_MIN_SECONDS,
  CLICK_SUSPECT_TOO_FAST,
} from "~/lib/constants";
import { findAttributionSignals, isBillableAttribution, resolveAttribution } from "~/lib/recovery/attribution";

import { createInMemoryDb } from "./helpers/inmemory-db";

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

const harness = vi.hoisted(() => ({ db: null as unknown, now: new Date() }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { recordClick, recordHoneypot } = await import("~/lib/engagement/record");

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
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
      {} as Env,
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

  it("a click 2 seconds after the send is recorded AND marked too_fast", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 2_000));

    const row = await stepRow(db);
    // Recorded, not suppressed: the merchant still sees that something fetched.
    expect(row.clickedAt).not.toBeNull();
    expect(row.clickSuspectReason).toBe(CLICK_SUSPECT_TOO_FAST);
  });

  it("and it cannot attribute the recovery, so it never bills", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 2_000));

    const result = await attribution(db);
    expect(result).toEqual({ kind: "stripe_baseline", ref: null });
    expect(isBillableAttribution(result.kind)).toBe(false);
  });

  // THE CONTROL, and the one the brief asks for by name. A guard that marked
  // every click suspect would pass every assertion above.
  it("A HUMAN CLICK AT 61 SECONDS IS NOT SUSPECT, and it bills", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 61_000));

    const row = await stepRow(db);
    expect(row.clickedAt).not.toBeNull();
    expect(row.clickSuspectReason).toBeNull();

    const result = await attribution(db);
    expect(result).toEqual({ kind: "email_engaged", ref: STEP });
    expect(isBillableAttribution(result.kind)).toBe(true);
  });

  // Both sides of the boundary, because a threshold asserted on one side has an
  // edge nobody measured.
  it("exactly 60 seconds is NOT suspect", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 60_000));
    expect((await stepRow(db)).clickSuspectReason).toBeNull();
  });

  it("one millisecond under 60 seconds IS suspect", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 59_999));
    expect((await stepRow(db)).clickSuspectReason).toBe(CLICK_SUSPECT_TOO_FAST);
  });

  it("a step that was never sent has no gap to measure and is not marked", async () => {
    const db = await seed();
    await db.update(recoverySteps).set({ executedAt: null }).where(eq(recoverySteps.id, STEP));
    await clickAt(new Date(SENT_AT.getTime() + 1_000));
    expect((await stepRow(db)).clickSuspectReason).toBeNull();
  });
});

describe("trigger two: the honeypot", () => {
  it("a fetch marks the step, and the later real click cannot bill", async () => {
    const db = await seed();

    // The scanner fetches every link in the message, the trap included.
    await recordHoneypot({} as Env, { stepId: STEP, accountId: ACCOUNT, kind: "honeypot" });
    // Then the customer genuinely clicks, hours later, so the 60-second test
    // would clear it. The honeypot is what catches this one.
    await clickAt(new Date(SENT_AT.getTime() + 4 * 60 * 60 * 1000));

    const row = await stepRow(db);
    expect(row.clickedAt).not.toBeNull();
    expect(row.clickSuspectReason).toBe(CLICK_SUSPECT_HONEYPOT);
    expect(await attribution(db)).toEqual({ kind: "stripe_baseline", ref: null });
  });

  it("A CLICK STAMP MUST NOT CLEAR AN EXISTING MARK, which is the ordering trap", async () => {
    const db = await seed();
    await recordHoneypot({} as Env, { stepId: STEP, accountId: ACCOUNT, kind: "honeypot" });
    await clickAt(new Date(SENT_AT.getTime() + 4 * 60 * 60 * 1000));
    // buildClickStamp writes the suspect column only when it HAS a reason. If
    // it wrote null unconditionally it would launder the click the honeypot
    // just caught, and every assertion above would still pass except this one.
    expect((await stepRow(db)).clickSuspectReason).toBe(CLICK_SUSPECT_HONEYPOT);
  });

  it("works in the other order too: click first, honeypot after", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 4 * 60 * 60 * 1000));
    expect((await stepRow(db)).clickSuspectReason).toBeNull();

    await recordHoneypot({} as Env, { stepId: STEP, accountId: ACCOUNT, kind: "honeypot" });

    expect((await stepRow(db)).clickSuspectReason).toBe(CLICK_SUSPECT_HONEYPOT);
    expect(await attribution(db)).toEqual({ kind: "stripe_baseline", ref: null });
  });

  it("a repeated fetch does not overwrite the reason already recorded", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 2_000));
    expect((await stepRow(db)).clickSuspectReason).toBe(CLICK_SUSPECT_TOO_FAST);

    await recordHoneypot({} as Env, { stepId: STEP, accountId: ACCOUNT, kind: "honeypot" });
    // The first reason stands: the ledger should say which test the click first
    // failed, not the most recent one.
    expect((await stepRow(db)).clickSuspectReason).toBe(CLICK_SUSPECT_TOO_FAST);
  });

  it("NO HONEYPOT AT ALL leaves an ordinary click billable", async () => {
    const db = await seed();
    await clickAt(new Date(SENT_AT.getTime() + 4 * 60 * 60 * 1000));

    expect((await stepRow(db)).clickSuspectReason).toBeNull();
    expect(await attribution(db)).toEqual({ kind: "email_engaged", ref: STEP });
  });
});

describe("the trap is invisible and looks like everything else", () => {
  it("the injected link is hidden three ways, because one is escapable", async () => {
    const { appendHoneypotLink } = await import("~/lib/engine/execute-step");
    const html = appendHoneypotLink("<p>body</p>", "https://foxhoundapp.test/e/h/tok");

    expect(html).toContain("<p>body</p>");
    // Sighted, screen-reader and keyboard routes to it all closed. Any one
    // alone leaves a way for a person to reach it and be marked a scanner.
    expect(html).toContain('style="display:none"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("https://foxhoundapp.test/e/h/tok");
  });

  it("its text gives no hint that it is a trap", async () => {
    const { appendHoneypotLink } = await import("~/lib/engine/execute-step");
    const html = appendHoneypotLink("", "https://x/e/h/t").toLowerCase();
    for (const tell of ["do not", "don't", "bot", "trap", "honeypot", "robot"]) {
      expect(html).not.toContain(tell);
    }
  });

  it("the send carries the pixel AND the trap together", async () => {
    const { appendOpenPixel, appendHoneypotLink } = await import("~/lib/engine/execute-step");
    const html = appendHoneypotLink(appendOpenPixel("<p>b</p>", "https://x/e/o/t"), "https://x/e/h/t");
    expect(html).toContain("/e/o/t");
    expect(html).toContain("/e/h/t");
  });
});
