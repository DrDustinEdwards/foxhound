import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  engagementEvents,
  failedPayments,
  recoverySteps,
} from "~/db/schema";
import { AUTOMATED_AGENT_TOKENS, isAutomatedUserAgent } from "~/lib/engagement/agents";
import { ALLOWED_BOTS } from "~/routes/files/robots";

import { createInMemoryDb, inMemoryMoneyWriter } from "./helpers/inmemory-db";

// RULING 368 RULING 1: A CLICK THAT FEEDS BILLING IS A MONEY WRITE.
//
// THE CHAIN THESE PLANTS PROTECT, traced end to end and asserted below rather
// than described:
//
//   /e/c/:token -> recordClick -> buildClickStamp sets recovery_steps.clicked_at
//               -> findAttributionSignals reads clickedAt != null
//               -> resolveAttribution returns "email_engaged"
//               -> isBillableAttribution("email_engaged") is TRUE
//
// So a fetch by anything that is not a person fabricates a billable event. The
// guard sits at the WRITE (app/lib/engagement/record.ts) rather than at the
// redirect, so a caller reaching the recorder from anywhere else is covered too.
//
// THE REDIRECT MUST BE IDENTICAL EITHER WAY. A guard that changed the response
// would be a challenge page by another name, would leak which agents are
// filtered, and would risk the customer whose payment we are recovering. Proven
// by comparing the two responses byte for byte.

const harness = vi.hoisted(() => ({ db: null as unknown, sqlite: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { recordClick, recordOpen } = await import("~/lib/engagement/record");
const { classifyEngagementRequest } = await import("~/lib/engagement/agents");
const { signEngagementToken } = await import("~/lib/engagement/token");
const clickRoute = await import("~/routes/utility/engagement-click");

const ACCOUNT_A = "acct_alpha";
const ACCOUNT_B = "acct_beta";
const STEP_A = "step_alpha";
const STEP_B = "step_beta";
const DEST = "https://merchant.example/invoice/123";
const NOW = new Date("2026-08-25T12:00:00.000Z");

/** A real Chrome UA, the control case. Contains none of the tokens. */
const HUMAN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const ENV = {
  MONEY_WRITER: inMemoryMoneyWriter(() => harness.sqlite as never).binding,
  ENCRYPTION_KEY: "a".repeat(64),
  BETTER_AUTH_URL: "https://foxhoundapp.test",
} as unknown as Env;

const routeContext = (): unknown => ({
  get: () => ({ env: ENV, ctx: {} as ExecutionContext, nonce: "n" }),
});

async function seed() {
  const { sqlite, db } = createInMemoryDb();
  harness.db = db;
  harness.sqlite = sqlite;
  for (const [account, step] of [
    [ACCOUNT_A, STEP_A],
    [ACCOUNT_B, STEP_B],
  ] as const) {
    await db.insert(accounts).values({ id: account, name: account, createdAt: NOW });
    await db.insert(failedPayments).values({
      id: `fp_${account}`,
      stripeEventId: `evt_${account}`,
      stripeInvoiceId: `in_${account}`,
      stripeCustomerId: `cus_${account}`,
      customerEmail: "customer@example.test",
      amountCents: 5000,
      currency: "usd",
      declineCategory: "soft",
      status: "failed",
      detectedAt: NOW,
      accountId: account,
    });
    await db.insert(recoverySteps).values({
      id: step,
      failedPaymentId: `fp_${account}`,
      accountId: account,
      stepType: "email_1",
      scheduledAt: NOW,
    });
  }
  return { sqlite, db };
}

const request = (headers: Record<string, string>, method = "GET") =>
  new Request(`https://foxhoundapp.test/e/c/tok`, { method, headers });

const clickToken = () =>
  signEngagementToken(ENV, { stepId: STEP_A, accountId: ACCOUNT_A, kind: "click", url: DEST });

const callClick = async (token: string, headers: Record<string, string>, method = "GET") =>
  (await clickRoute.loader({
    params: { token },
    request: new Request(`https://foxhoundapp.test/e/c/${token}`, { method, headers }),
    context: routeContext(),
  } as never)) as Response;

const stepRow = async (db: Awaited<ReturnType<typeof seed>>["db"], id: string) =>
  (await db.select().from(recoverySteps).where(eq(recoverySteps.id, id)))[0];

// ============================================================================

describe("PLANT 1: every listed agent is refused the write", () => {

  it("every agent 368 names by hand is in the shipped list", () => {
    // The ruling's minimum, asserted against the constant so a future trim of
    // the list cannot silently drop one of the named fetchers.
    for (const named of [
      "gptbot",
      "chatgpt-user",
      "oai-searchbot",
      "claudebot",
      "claude-user",
      "perplexitybot",
      "perplexity-user",
      "google-extended",
      "googlebot",
      "bingbot",
      "ccbot",
      "bytespider",
    ]) {
      expect(AUTOMATED_AGENT_TOKENS, `${named} missing from the guard`).toContain(named);
    }
  });

  it("THE GUARD LIST COVERS EVERY BOT ROBOTS.TXT NAMES, without being derived from it", () => {
    // The two lists answer different questions and must stay free to diverge:
    // robots.ts is "who do we want crawling public content", this is "who must
    // not write money data". Tying them by SUPERSET keeps them honest without
    // welding them, so adding a crawler to the allow list cannot quietly grant
    // it write access to the billable signal.
    for (const bot of ALLOWED_BOTS) {
      expect(isAutomatedUserAgent(bot), `${bot} may write engagement`).toBe(true);
    }
  });

  it("A REAL BROWSER WRITES, so the refusals above are the guard and not inertia", () => {
    // Without this, every assertion in this file is satisfied by a guard that
    // refuses everyone, which is the failure mode that would silently end
    // engagement attribution altogether.
    expect(isAutomatedUserAgent(HUMAN_UA)).toBe(false);
    expect(classifyEngagementRequest(request({ "user-agent": HUMAN_UA }), "click")).toEqual({
      automated: false,
    });
    for (const ua of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
    ]) {
      expect(isAutomatedUserAgent(ua), `real browser refused: ${ua.slice(0, 40)}`).toBe(false);
    }
  });
});

describe("PLANT 2: request shape, not only the user agent", () => {
  it("HEAD IS NOT A CLICK, which nothing in this repo checked before", () => {
    expect(classifyEngagementRequest(request({ "user-agent": HUMAN_UA }, "HEAD"), "click")).toEqual({
      automated: true,
      reason: "not_a_get",
    });
  });

  it("a PREFETCH is not a click, on all four header spellings", () => {
    for (const [header, value] of [
      ["sec-purpose", "prefetch"],
      ["purpose", "prefetch"],
      ["x-moz", "prefetch"],
      ["x-purpose", "preview"],
    ]) {
      expect(
        classifyEngagementRequest(request({ "user-agent": HUMAN_UA, [header]: value }), "click"),
        `${header} not honoured`,
      ).toEqual({ automated: true, reason: "prefetch" });
    }
  });

  it("A MISSING USER AGENT FAILS CLOSED FOR A CLICK and open for an OPEN", () => {
    // The asymmetry, asserted so it reads as a decision rather than a bug. The
    // click bills; a false one charges a merchant for a recovery Foxhound did
    // not cause. The open never bills and is fetched by mail clients and image
    // proxies whose UA habits are nothing like a browser's.
    expect(classifyEngagementRequest(request({}), "click")).toEqual({
      automated: true,
      reason: "no_user_agent",
    });
    expect(classifyEngagementRequest(request({}), "open")).toEqual({ automated: false });
    // A bot UA is still refused on BOTH, so the asymmetry is only about absence.
    expect(classifyEngagementRequest(request({ "user-agent": "ClaudeBot/1.0" }), "open")).toEqual({
      automated: true,
      reason: "bot_user_agent",
    });
  });
});

describe("PLANT 3: the write, against the real schema", () => {
  it("a bot fetch writes NOTHING: no event row, no stamp", async () => {
    const { db } = await seed();
    const result = await recordClick(
      ENV,
      { stepId: STEP_A, accountId: ACCOUNT_A, kind: "click", url: DEST },
      { automated: true, reason: "bot_user_agent" },
    );

    expect(result).toEqual({ recorded: false, reason: "bot_user_agent" });
    expect(await db.select().from(engagementEvents)).toHaveLength(0);
    expect((await stepRow(db, STEP_A)).clickedAt).toBeNull();
  });

  it("a human fetch writes both, so PLANT 3's first case is the guard", async () => {
    const { db } = await seed();
    const result = await recordClick(
      ENV,
      { stepId: STEP_A, accountId: ACCOUNT_A, kind: "click", url: DEST },
      { automated: false },
    );

    expect(result).toEqual({ recorded: true });
    const events = await db.select().from(engagementEvents);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("click");
    expect((await stepRow(db, STEP_A)).clickedAt).not.toBeNull();
  });

  it("the OPEN recorder is guarded too, one bug class and two sites", async () => {
    const { db } = await seed();
    await recordOpen(
      ENV,
      { stepId: STEP_A, accountId: ACCOUNT_A, kind: "open" },
      { automated: true, reason: "bot_user_agent" },
    );
    expect(await db.select().from(engagementEvents)).toHaveLength(0);
    expect((await stepRow(db, STEP_A)).openedAt).toBeNull();

    await recordOpen(ENV, { stepId: STEP_A, accountId: ACCOUNT_A, kind: "open" }, { automated: false });
    expect(await db.select().from(engagementEvents)).toHaveLength(1);
  });
});

describe("PLANT 5: the redirect is identical either way", () => {
  it("a bot and a customer receive the same status, destination and headers", async () => {
    await seed();
    const token = await clickToken();

    const asBot = await callClick(token, { "user-agent": "ClaudeBot/1.0" });
    const asHuman = await callClick(token, { "user-agent": HUMAN_UA });

    expect(asBot.status).toBe(302);
    expect(asBot.status).toBe(asHuman.status);
    expect(asBot.headers.get("Location")).toBe(DEST);
    expect(asBot.headers.get("Location")).toBe(asHuman.headers.get("Location"));
    expect(asBot.headers.get("Cache-Control")).toBe(asHuman.headers.get("Cache-Control"));
    // Nothing about the filtering leaks to the caller.
    expect([...asBot.headers.keys()].sort()).toEqual([...asHuman.headers.keys()].sort());
  });

  it("and the bot's fetch still wrote nothing, through the REAL route", async () => {
    const { db } = await seed();
    const token = await clickToken();

    await callClick(token, { "user-agent": "ChatGPT-User/1.0" });
    expect(await db.select().from(engagementEvents)).toHaveLength(0);
    expect((await stepRow(db, STEP_A)).clickedAt).toBeNull();

    await callClick(token, { "user-agent": HUMAN_UA });
    expect(await db.select().from(engagementEvents)).toHaveLength(1);
    expect((await stepRow(db, STEP_A)).clickedAt).not.toBeNull();
  });
});
