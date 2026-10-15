import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accounts, engagementEvents, failedPayments, recoverySteps } from "~/db/schema";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Row F9 (J26, job_652baa37855c): the /e/o/:token open pixel against Recova's
// email.opened handler in app/api/webhooks/resend/route.ts (blob f9175569, read
// whole). Per open Recova sets, on the recovery step:
//   email_opened_count  += 1 (null read as 0)            on every open
//   last_opened_at       = now                            on every open
//   opened_at            = now                            first open only
//   time_to_open_minutes = floor((now - executed_at)/60000)  once, when executed_at is set
// Foxhound keeps its own engine: a first-party pixel, the automated-source guard
// (automated opens write nothing), one idempotent engagement_events row per step.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { recordOpen } = await import("~/lib/engagement/record");

const ENV = { ENCRYPTION_KEY: "a".repeat(64) } as unknown as Env;
const ACCOUNT = "acct_sample";
const STEP = "step_sample";
const SENT = new Date("2026-10-14T09:00:00.000Z");
const HUMAN = { automated: false } as const;
const OPEN = { stepId: STEP, accountId: ACCOUNT, kind: "open" } as const;

async function seed(executedAt: Date | null = SENT) {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(accounts).values({ id: ACCOUNT, name: "Sample", createdAt: SENT });
  await db.insert(failedPayments).values({
    id: "fp_sample",
    stripeEventId: "evt_sample",
    stripeInvoiceId: "in_sample",
    stripeCustomerId: "cus_sample",
    customerEmail: "sam@example.com",
    amountCents: 5000,
    currency: "usd",
    declineCategory: "soft",
    status: "failed",
    detectedAt: SENT,
    accountId: ACCOUNT,
  });
  await db.insert(recoverySteps).values({
    id: STEP,
    failedPaymentId: "fp_sample",
    accountId: ACCOUNT,
    stepType: "email_1",
    scheduledAt: SENT,
    executedAt,
  });
  return db;
}

const step = async (db: Awaited<ReturnType<typeof seed>>) =>
  (await db.select().from(recoverySteps).where(eq(recoverySteps.id, STEP)))[0];

async function openAt(at: Date, source: Parameters<typeof recordOpen>[2] = HUMAN) {
  vi.setSystemTime(at);
  return recordOpen(ENV, OPEN, source);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("F9: every human open counts, as Recova's email.opened did", () => {
  it("the first open sets count 1, opened_at, last_opened_at and time to open (floored minutes)", async () => {
    vi.useFakeTimers();
    const db = await seed();
    const first = new Date(SENT.getTime() + 125 * 60_000 + 59_000); // 125 min 59 s later

    expect(await openAt(first)).toEqual({ recorded: true });
    const row = await step(db);
    expect(row.emailOpenedCount).toBe(1);
    expect(row.openedAt?.getTime()).toBe(first.getTime());
    expect(row.lastOpenedAt?.getTime()).toBe(first.getTime());
    expect(row.timeToOpenMinutes).toBe(125);
  });

  it("a later open adds one and moves last_opened_at, leaving opened_at and time to open alone", async () => {
    vi.useFakeTimers();
    const db = await seed();
    const first = new Date(SENT.getTime() + 10 * 60_000);
    const second = new Date(SENT.getTime() + 3 * 60 * 60_000);
    const third = new Date(SENT.getTime() + 26 * 60 * 60_000);

    await openAt(first);
    await openAt(second);
    await openAt(third);
    const row = await step(db);
    expect(row.emailOpenedCount).toBe(3);
    expect(row.openedAt?.getTime()).toBe(first.getTime());
    expect(row.lastOpenedAt?.getTime()).toBe(third.getTime());
    expect(row.timeToOpenMinutes).toBe(10);
  });

  it("the engagement_events row stays one per step however many opens arrive", async () => {
    vi.useFakeTimers();
    const db = await seed();
    await openAt(new Date(SENT.getTime() + 60_000));
    await openAt(new Date(SENT.getTime() + 120_000));
    const events = await db.select().from(engagementEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.idempotencyKey).toBe(`open:${STEP}`);
  });

  it("a step with no executed_at gets no time to open, as Recova's guard has it", async () => {
    vi.useFakeTimers();
    const db = await seed(null);
    await openAt(new Date(SENT.getTime() + 60 * 60_000));
    const row = await step(db);
    expect(row.emailOpenedCount).toBe(1);
    expect(row.timeToOpenMinutes).toBeNull();
  });

  it("an open before executed_at floors the negative gap as Recova's Math.floor does", async () => {
    vi.useFakeTimers();
    const db = await seed();
    await openAt(new Date(SENT.getTime() - 30_000)); // 30 s before the send was stamped
    expect((await step(db)).timeToOpenMinutes).toBe(-1);
  });

  it("an automated open writes nothing: no count, no stamp, no event", async () => {
    vi.useFakeTimers();
    const db = await seed();
    const result = await openAt(new Date(SENT.getTime() + 60 * 60_000), {
      automated: true,
      reason: "bot_user_agent",
    });
    expect(result).toEqual({ recorded: false, reason: "bot_user_agent" });
    const row = await step(db);
    expect(row.emailOpenedCount).toBeNull();
    expect(row.openedAt).toBeNull();
    expect(row.lastOpenedAt).toBeNull();
    expect(row.timeToOpenMinutes).toBeNull();
    expect(await db.select().from(engagementEvents)).toHaveLength(0);
  });
});
