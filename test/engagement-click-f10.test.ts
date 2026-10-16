import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accounts, engagementEvents, failedPayments, recoverySteps } from "~/db/schema";
import { CLICK_SUSPECT_HONEYPOT, CLICK_SUSPECT_TOO_FAST } from "~/lib/constants";
import { findAttributionSignals, resolveAttribution } from "~/lib/recovery/attribution";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Row F10 (J27, job_a6f44c83feaa): the /e/c/:token click recorder against
// Recova's email.clicked handler in app/api/webhooks/resend/route.ts (blob
// f9175569, read whole). Per click Recova sets, on the recovery step:
//   email_clicked_count += 1 (null read as 0)   on every click
//   last_clicked_at      = now                   on every click
//   clicked_at           = now                   first click only
// Foxhound keeps its own engine and its money rules (RULES.md 3.4): automated
// requests write nothing, a suspect click is marked and never bills, and the
// billing reads (clicked_at, click_suspect_reason) stay first-click only. The
// engagement_events row stays one per step on its existing idempotency key.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { recordClick, recordHoneypot } = await import("~/lib/engagement/record");

const ENV = {} as Env;
const ACCOUNT = "acct_sample";
const PAYMENT = "fp_sample";
const STEP = "step_sample";
const SENT = new Date("2026-10-14T09:00:00.000Z");
const RECOVERED_AT = new Date("2026-10-15T09:00:00.000Z");
const HUMAN = { automated: false } as const;
const CLICK = { stepId: STEP, accountId: ACCOUNT, kind: "click", url: "https://merchant.example/pay" } as const;

const at = (minutes: number) => new Date(SENT.getTime() + minutes * 60_000);

async function seed(emailClickedCount: number | null = null) {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(accounts).values({ id: ACCOUNT, name: "Sample", createdAt: SENT });
  await db.insert(failedPayments).values({
    id: PAYMENT,
    stripeEventId: "evt_sample",
    stripeInvoiceId: "in_sample",
    stripeCustomerId: "cus_sample",
    customerEmail: "sam@example.com",
    amountCents: 5000,
    currency: "usd",
    declineCategory: "soft",
    status: "active",
    detectedAt: SENT,
    accountId: ACCOUNT,
  });
  await db.insert(recoverySteps).values({
    id: STEP,
    failedPaymentId: PAYMENT,
    accountId: ACCOUNT,
    stepType: "email_day1",
    stepNumber: 1,
    scheduledAt: SENT,
    executedAt: SENT,
    result: "email_sent",
    emailClickedCount,
  });
  return db;
}

type TestDb = Awaited<ReturnType<typeof seed>>;

const step = async (db: TestDb) =>
  (await db.select().from(recoverySteps).where(eq(recoverySteps.id, STEP)))[0];

async function clickAt(when: Date, source: Parameters<typeof recordClick>[2] = HUMAN) {
  vi.useFakeTimers();
  vi.setSystemTime(when);
  return recordClick(ENV, CLICK, source);
}

async function attribution(db: TestDb) {
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

afterEach(() => {
  vi.useRealTimers();
});

describe("F10: every human click counts, as Recova's email.clicked did", () => {
  it("the first click sets count 1, clicked_at and last_clicked_at", async () => {
    const db = await seed();
    expect(await clickAt(at(10))).toEqual({ recorded: true });
    const row = await step(db);
    expect(row.emailClickedCount).toBe(1);
    expect(row.clickedAt?.getTime()).toBe(at(10).getTime());
    expect(row.lastClickedAt?.getTime()).toBe(at(10).getTime());
  });

  it("a later click adds one and moves last_clicked_at, while clicked_at keeps the first", async () => {
    const db = await seed();
    await clickAt(at(10));
    await clickAt(at(95));
    await clickAt(at(300));
    const row = await step(db);
    expect(row.emailClickedCount).toBe(3);
    expect(row.clickedAt?.getTime()).toBe(at(10).getTime());
    expect(row.lastClickedAt?.getTime()).toBe(at(300).getTime());
  });

  it("an existing count carries on from where it was, as Recova's (count ?? 0) + 1", async () => {
    const db = await seed(4);
    await clickAt(at(10));
    expect((await step(db)).emailClickedCount).toBe(5);
  });

  it("an automated click writes nothing, the first time or the tenth", async () => {
    const db = await seed();
    await clickAt(at(10));
    expect(await clickAt(at(20), { automated: true, reason: "bot_user_agent" })).toEqual({
      recorded: false,
      reason: "bot_user_agent",
    });
    const row = await step(db);
    expect(row.emailClickedCount).toBe(1);
    expect(row.lastClickedAt?.getTime()).toBe(at(10).getTime());
  });

  it("the engagement_events row stays one per step, on its existing key", async () => {
    const db = await seed();
    await clickAt(at(10));
    await clickAt(at(95));
    const events = await db.select().from(engagementEvents).where(eq(engagementEvents.recoveryStepId, STEP));
    expect(events).toHaveLength(1);
    expect(events[0].idempotencyKey).toBe(`click:${STEP}`);
    expect(events[0].occurredAt.getTime()).toBe(at(10).getTime());
  });
});

describe("F10: a repeat click never changes what bills (RULES.md 3.4)", () => {
  it("a too-fast first click stays suspect after a later, slower click", async () => {
    const db = await seed();
    await clickAt(new Date(SENT.getTime() + 5_000));
    await clickAt(at(30));
    const row = await step(db);
    expect(row.emailClickedCount).toBe(2);
    expect(row.clickSuspectReason).toBe(CLICK_SUSPECT_TOO_FAST);
    expect(row.clickedAt?.getTime()).toBe(SENT.getTime() + 5_000);
    expect((await attribution(db)).kind).not.toBe("email_engaged");
  });

  it("a honeypot mark set after the first click survives every later click", async () => {
    const db = await seed();
    await clickAt(at(10));
    await recordHoneypot(ENV, { stepId: STEP, accountId: ACCOUNT, kind: "honeypot" });
    await clickAt(at(40));
    const row = await step(db);
    expect(row.clickSuspectReason).toBe(CLICK_SUSPECT_HONEYPOT);
    expect((await attribution(db)).kind).not.toBe("email_engaged");
  });

  it("a clean first click stays clean and billable after later clicks", async () => {
    const db = await seed();
    await clickAt(at(10));
    const before = await attribution(db);
    await clickAt(at(95));
    const row = await step(db);
    expect(row.clickSuspectReason).toBeNull();
    expect(before.kind).toBe("email_engaged");
    expect(await attribution(db)).toEqual(before);
  });

  it("a too-fast first click after a honeypot fetch is marked too_fast, as before this row", async () => {
    const db = await seed();
    await recordHoneypot(ENV, { stepId: STEP, accountId: ACCOUNT, kind: "honeypot" });
    await clickAt(new Date(SENT.getTime() + 5_000));
    expect((await step(db)).clickSuspectReason).toBe(CLICK_SUSPECT_TOO_FAST);
  });
});
