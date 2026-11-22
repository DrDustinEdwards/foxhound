import {
  AI_SEARCH_BOTS,
  AI_TRAINING_BOTS,
  SEARCH_ENGINE_BOTS,
} from "@drdustinedwards/site-helpers/robots";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { accounts, engagementEvents, failedPayments, recoverySteps } from "~/db/schema";
import { CLICK_SUSPECT_HONEYPOT, CLICK_SUSPECT_TOO_FAST } from "~/lib/constants";
import { AUTOMATED_AGENT_TOKENS, isAutomatedUserAgent } from "~/lib/engagement/agents";
import { findAttributionSignals, resolveAttribution } from "~/lib/recovery/attribution";

import { createInMemoryDb, inMemoryMoneyWriter } from "./helpers/inmemory-db";

// A click that feeds billing is a money write: /e/c/:token -> recordClick sets
// recovery_steps.clicked_at -> findAttributionSignals reads it -> "email_engaged" is billable. So a
// fetch by anything that is not a person would fabricate a billable event, and the guard sits at
// the write (app/lib/engagement/record.ts), not at the redirect. The redirect is identical either
// way, so the filtering never leaks to the caller.

const harness = vi.hoisted(() => ({ db: null as unknown, sqlite: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { recordClick, recordOpen, recordHoneypot } = await import("~/lib/engagement/record");
const { classifyEngagementRequest } = await import("~/lib/engagement/agents");
const { signEngagementToken } = await import("~/lib/engagement/token");
const clickRoute = await import("~/routes/utility/engagement-click");

const money = inMemoryMoneyWriter(() => harness.sqlite as never);
const ENV = {
  MONEY_WRITER: money.binding,
  ENCRYPTION_KEY: "a".repeat(64),
  BETTER_AUTH_URL: "https://foxhoundapp.test",
} as unknown as Env;

const ACCOUNT = "acct_sample";
const PAYMENT = "fp_sample";
const STEP = "step_sample";
const DEST = "https://merchant.example/invoice/123";
const SENT = new Date("2026-10-14T09:00:00.000Z");
const RECOVERED_AT = new Date("2026-10-15T09:00:00.000Z");
const HUMAN = { automated: false } as const;
const CLICK = { stepId: STEP, accountId: ACCOUNT, kind: "click", url: DEST } as const;
const OPEN = { stepId: STEP, accountId: ACCOUNT, kind: "open" } as const;

/** A real Chrome UA, the control case. Contains none of the bot tokens. */
const HUMAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const at = (minutes: number) => new Date(SENT.getTime() + minutes * 60_000);

async function seed(executedAt: Date | null = SENT) {
  const { db, sqlite } = createInMemoryDb();
  harness.db = db;
  harness.sqlite = sqlite;
  money.commits.length = 0;
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
    executedAt,
    result: "email_sent",
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

const request = (headers: Record<string, string>, method = "GET") =>
  new Request(`https://foxhoundapp.test/e/c/tok`, { method, headers });

const callClick = async (token: string, headers: Record<string, string>) =>
  (await clickRoute.loader({
    params: { token },
    request: new Request(`https://foxhoundapp.test/e/c/${token}`, { method: "GET", headers }),
    context: { get: () => ({ env: ENV, ctx: {} as ExecutionContext }) },
  } as never)) as Response;

afterEach(() => {
  vi.useRealTimers();
});

describe("which requests are automated", () => {
  it("the guard list names the AI and search fetchers and covers every robots.txt bot, but not a browser", () => {
    for (const named of ["gptbot", "claudebot", "perplexitybot", "googlebot", "bingbot", "ccbot"]) {
      expect(AUTOMATED_AGENT_TOKENS).toContain(named);
    }
    // robots.txt is who we want crawling; this is who must not write money data. A superset keeps
    // the two honest without welding them.
    for (const bot of [...SEARCH_ENGINE_BOTS, ...AI_SEARCH_BOTS, ...AI_TRAINING_BOTS]) {
      expect(isAutomatedUserAgent(bot), `${bot} may write engagement`).toBe(true);
    }
    // Without a control, a guard that refuses everyone would pass every case here.
    expect(classifyEngagementRequest(request({ "user-agent": HUMAN_UA }), "click")).toEqual({
      automated: false,
    });
    for (const ua of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
    ]) {
      expect(isAutomatedUserAgent(ua)).toBe(false);
    }
  });

  it("HEAD is not a click, and a prefetch is not a click on any of its header spellings", () => {
    expect(classifyEngagementRequest(request({ "user-agent": HUMAN_UA }, "HEAD"), "click")).toEqual(
      { automated: true, reason: "not_a_get" },
    );
    for (const [header, value] of [
      ["sec-purpose", "prefetch"],
      ["purpose", "prefetch"],
      ["x-moz", "prefetch"],
      ["x-purpose", "preview"],
    ]) {
      expect(
        classifyEngagementRequest(request({ "user-agent": HUMAN_UA, [header]: value }), "click"),
        `${header} not honored`,
      ).toEqual({ automated: true, reason: "prefetch" });
    }
  });

  it("a missing user agent fails closed for a click (it bills) and open for an open (it never does)", () => {
    expect(classifyEngagementRequest(request({}), "click")).toEqual({
      automated: true,
      reason: "no_user_agent",
    });
    expect(classifyEngagementRequest(request({}), "open")).toEqual({ automated: false });
    expect(classifyEngagementRequest(request({ "user-agent": "ClaudeBot/1.0" }), "open")).toEqual({
      automated: true,
      reason: "bot_user_agent",
    });
  });
});

describe("recording a click", () => {
  it("a bot fetch writes nothing and a human fetch writes the event and the stamp", async () => {
    const db = await seed();
    const bot = await recordClick(ENV, CLICK, { automated: true, reason: "bot_user_agent" });
    expect(bot).toEqual({ recorded: false, reason: "bot_user_agent" });
    expect(await db.select().from(engagementEvents)).toHaveLength(0);
    expect((await step(db)).clickedAt).toBeNull();

    expect(await clickAt(at(10))).toEqual({ recorded: true });
    const events = await db.select().from(engagementEvents);
    expect(events).toHaveLength(1);
    expect(events[0].idempotencyKey).toBe(`click:${STEP}`);
    expect((await step(db)).clickedAt?.getTime()).toBe(at(10).getTime());
  });

  it("the redirect is identical for a bot and a customer, and the bot's fetch still writes nothing", async () => {
    const db = await seed();
    const token = await signEngagementToken(ENV, { ...CLICK });

    const asBot = await callClick(token, { "user-agent": "ClaudeBot/1.0" });
    expect(await db.select().from(engagementEvents)).toHaveLength(0);
    expect((await step(db)).clickedAt).toBeNull();

    const asHuman = await callClick(token, { "user-agent": HUMAN_UA });
    expect(asBot.status).toBe(302);
    expect(asBot.status).toBe(asHuman.status);
    expect(asBot.headers.get("Location")).toBe(DEST);
    expect(asBot.headers.get("Location")).toBe(asHuman.headers.get("Location"));
    expect([...asBot.headers.keys()].sort()).toEqual([...asHuman.headers.keys()].sort());
    expect(await db.select().from(engagementEvents)).toHaveLength(1);
  });

  it("commits through the account's money Durable Object, one commit per click and one event row per step", async () => {
    const db = await seed();
    await clickAt(at(10));
    expect(money.commits).toHaveLength(1);
    const [commit] = money.commits;
    expect(commit.partition).toBe(ACCOUNT);
    expect(commit.statements.map((s) => s.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      'insert into "engagement_events"',
      'update "recovery_steps" set',
    ]);

    await clickAt(at(95));
    expect((await step(db)).emailClickedCount).toBe(2);
    expect(new Set(money.commits.map((c) => c.idempotencyKey)).size).toBe(2);
    const events = await db.select().from(engagementEvents);
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt.getTime()).toBe(at(10).getTime());
  });

  it("a click on a step that does not exist is not reported recorded", async () => {
    const db = await seed();
    vi.useFakeTimers();
    vi.setSystemTime(at(10));
    const result = await recordClick(ENV, { ...CLICK, stepId: "step_missing" }, HUMAN);
    expect(result).toEqual({ recorded: false, reason: "unknown_step" });
    expect(await db.select().from(engagementEvents)).toHaveLength(0);
  });
});

describe("a suspect click never bills", () => {
  it("a click before executed_at is written is too fast", async () => {
    // Send first, claim second: a scanner can fetch the link in the seconds before the claim.
    const db = await seed(null);
    await clickAt(at(10));
    expect((await step(db)).clickSuspectReason).toBe(CLICK_SUSPECT_TOO_FAST);
    expect((await attribution(db)).kind).not.toBe("email_engaged");
  });

  it("a first click right after a honeypot fetch is marked too fast", async () => {
    const db = await seed();
    await recordHoneypot(ENV, { stepId: STEP, accountId: ACCOUNT, kind: "honeypot" });
    await clickAt(new Date(SENT.getTime() + 5_000));
    expect((await step(db)).clickSuspectReason).toBe(CLICK_SUSPECT_TOO_FAST);
  });

  it("a honeypot mark stays after a later click that would be too fast", async () => {
    const db = await seed();
    await clickAt(at(10));
    await recordHoneypot(ENV, { stepId: STEP, accountId: ACCOUNT, kind: "honeypot" });
    // A missing executed_at is the only way a click at minute twenty reads as too fast.
    await db.update(recoverySteps).set({ executedAt: null }).where(eq(recoverySteps.id, STEP));
    await clickAt(at(20));
    expect((await step(db)).clickSuspectReason).toBe(CLICK_SUSPECT_HONEYPOT);
    expect((await attribution(db)).kind).not.toBe("email_engaged");
  });
});

describe("recording an open", () => {
  it("the first open stamps count, opened_at and floored minutes to open", async () => {
    vi.useFakeTimers();
    const db = await seed();
    const first = new Date(SENT.getTime() + 125 * 60_000 + 59_000);
    vi.setSystemTime(first);

    expect(await recordOpen(ENV, OPEN, HUMAN)).toEqual({ recorded: true });
    const row = await step(db);
    expect(row.emailOpenedCount).toBe(1);
    expect(row.openedAt?.getTime()).toBe(first.getTime());
    expect(row.timeToOpenMinutes).toBe(125);
  });

  it("an automated open writes nothing: no count, no stamp, no event", async () => {
    vi.useFakeTimers();
    const db = await seed();
    vi.setSystemTime(at(60));
    const result = await recordOpen(ENV, OPEN, { automated: true, reason: "bot_user_agent" });
    expect(result).toEqual({ recorded: false, reason: "bot_user_agent" });
    const row = await step(db);
    expect(row.emailOpenedCount).toBeNull();
    expect(row.openedAt).toBeNull();
    expect(await db.select().from(engagementEvents)).toHaveLength(0);
  });
});
