import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, toolOutput } from "./helpers/mcp-client";

// SESSION 83: THE TWO READERS 375 APPROVED, NOW TWO KEYS OF ONE READER.
//
// WHY THEY EXIST. Sessions 79 and 80 shipped the brand-voice and
// intelligence-context writers with no way to read either back, so an agent
// asked to soften one voice had to send all five or guess, and an agent asked to
// correct the industry had to overwrite the two fields beside it blind. 375
// approved both readers with the read discipline of 77 and said they ride with
// the next MCP-adjacent session, which was session 83.
//
// THE REGROUP (job_874dc20ea9ac) folded `get_brand_voice` and
// `get_intelligence_context` into `foxhound_get_settings`, as its `brand_voice`
// and `intelligence_context` keys, and the two writers into the matching
// sections of `foxhound_update_settings`. Every property below is the same
// property, asserted on the new keys. The reader is wider now (it also carries
// the audit window, the toggles, the notification settings, the connections and
// the sender), so this file also pins the one thing that widening could leak:
// the Slack webhook URL, which is a credential and is reported only as
// `slackWebhookConfigured`.
//
// WHY THIS FILE EXISTS RATHER THAN A CASE IN THE 371 SUITE. That suite's
// two-account sweep drives every registered tool and asserts the other account
// appears nowhere, and it would have passed on these two the day they shipped
// WITHOUT TESTING ANYTHING: its fixture seeds no stripe connection and no
// merchant context, so both readers return null for both accounts and an
// absence assertion over two nulls is satisfied by construction. That is the
// same vacuum that let three tools leak for six sessions (376 item 7), caught
// here by writing the fixture the assertion needs instead of inheriting one.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");
const { MERCHANT_TOOLS, MERCHANT_TOOL_NAMES } = await import("~/lib/mcp/tools.server");

const MINE = "acct_mine";
const THEIRS = "acct_theirs";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const READ = "foxhound_get_settings";
const WRITE = "foxhound_update_settings";

/** Distinctive on both sides, so a leak returns the OTHER account's sentence
 *  rather than an empty string that an absence check would wave through. The
 *  webhook tail is distinctive too, so the absence check below cannot be
 *  satisfied by the URL appearing in some reformatted shape. */
const FIXTURES = {
  [MINE]: {
    voice: "Warm, plainspoken, never pushy.",
    industry: "artisanal telescope repair",
    customerType: "hobbyists",
    mrrCents: 412_00,
    slackWebhookUrl: "https://hooks.slack.com/services/T0MINE/B0MINE/zanzibarQuokkaSecret",
  },
  [THEIRS]: {
    voice: "Terse, clinical, faintly threatening.",
    industry: "industrial abrasives",
    customerType: "procurement departments",
    mrrCents: 999_00,
    slackWebhookUrl: null,
  },
} as const;

function env(): Env {
  return {
    DB: {},
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ check: async () => ({ allowed: true, retryAfterSec: 60 }) }),
    },
  } as unknown as Env;
}

async function seed(options: { disconnectMine?: boolean } = {}) {
  const { db } = createInMemoryDb();
  harness.db = db;
  const tokens: Record<string, string> = {};
  for (const account of [MINE, THEIRS] as const) {
    const fixture = FIXTURES[account];
    await db.insert(accounts).values({
      id: account,
      name: account,
      createdAt: NOW,
      currency: "usd",
      merchantIndustry: fixture.industry,
      primaryCustomerType: fixture.customerType,
      merchantMrrSelfReported: fixture.mrrCents,
      slackWebhookUrl: fixture.slackWebhookUrl,
    });
    const token = `${MCP_TOKEN_PREFIX}${account}`;
    tokens[account] = token;
    await db.insert(apiKeys).values({
      id: `key_${account}`,
      accountId: account,
      keyHash: await hashMcpToken(token),
      label: "agent",
      scope: MCP_TOKEN_SCOPE.MERCHANT,
      createdAt: NOW,
    });
    await db.insert(stripeConnections).values({
      id: `sc_${account}`,
      accountId: account,
      stripeUserId: `acct_stripe_${account}`,
      name: `Shop ${account}`,
      isPrimary: true,
      connectedAt: NOW,
      // 333: is_primary stays SET on a disconnected row, so the reader's null
      // check is what keeps a severed connection out of an agent's hands.
      disconnectedAt: options.disconnectMine && account === MINE ? NOW : null,
      createdAt: NOW,
      brandVoice: fixture.voice,
      brandVoiceSoft: `${fixture.voice} SOFT`,
      brandVoiceExpired: `${fixture.voice} EXPIRED`,
      brandVoiceNetwork: `${fixture.voice} NETWORK`,
      brandVoiceFraud: `${fixture.voice} FRAUD`,
    });
  }
  return { db, tokens };
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = (await handleMcpRequest(
    mcpRequest({ token, method: "tools/call", params: { name, arguments: args } }),
    env(),
    MERCHANT_TOOLS,
  )) as Response;
  const answer = await readMcp(res);
  const { isError, data } = toolOutput(answer);
  return { status: answer.status, text: answer.text, isError, data };
}

/** The read, asserted to have run: every caller below relies on the executor
 *  having answered, not on the SDK having refused before it did. */
async function readSettings(token: string, args: Record<string, unknown> = {}) {
  const out = await callTool(token, READ, args);
  expect(out.isError, out.text).toBe(false);
  return out;
}

// ============================================================================

describe("PLANT 1: both readers are registered and readable", () => {
  it("the reader ships, it is a read, and its writer ships beside it", () => {
    expect(MERCHANT_TOOL_NAMES).toContain(READ);
    expect(MERCHANT_TOOL_NAMES).toContain(WRITE);
    expect(MERCHANT_TOOLS.get(READ)!.annotations.readOnlyHint).toBe(true);
    expect(MERCHANT_TOOLS.get(READ)!.annotations.destructiveHint).toBe(false);
    // The two old names are gone, not aliased: a second spelling would be a
    // second surface for the same read to drift on.
    expect(MERCHANT_TOOL_NAMES).not.toContain("get_brand_voice");
    expect(MERCHANT_TOOL_NAMES).not.toContain("get_intelligence_context");
  });

  it("brand_voice returns the five voices and the connection id the brand_voice section takes", async () => {
    const { tokens } = await seed();
    const { data } = await readSettings(tokens[MINE]);
    const voices = data.brand_voice as Record<string, unknown>;
    expect(voices.general).toBe(FIXTURES[MINE].voice);
    expect(voices.soft).toBe(`${FIXTURES[MINE].voice} SOFT`);
    expect(voices.expired).toBe(`${FIXTURES[MINE].voice} EXPIRED`);
    expect(voices.network).toBe(`${FIXTURES[MINE].voice} NETWORK`);
    expect(voices.fraud).toBe(`${FIXTURES[MINE].voice} FRAUD`);
    // The id is the half that makes the reader useful rather than merely
    // informative: the brand_voice section requires a connection id and refuses
    // without one, so a reader that withheld it would leave the echo
    // workaround in place.
    expect(voices.id).toBe(`sc_${MINE}`);
    expect(Object.keys(voices).sort()).toEqual(["expired", "fraud", "general", "id", "network", "soft"]);
  });

  it("brand_voice round-trips: read, change one voice by its id, and the other four survive", async () => {
    const { tokens } = await seed();
    const before = (await readSettings(tokens[MINE])).data.brand_voice as Record<string, unknown>;
    const write = await callTool(tokens[MINE], WRITE, {
      brand_voice: { connection_id: before.id, soft: "Gentler still." },
    });
    expect(write.isError, write.text).toBe(false);
    const after = (await readSettings(tokens[MINE])).data.brand_voice as Record<string, unknown>;
    expect(after).toEqual({ ...before, soft: "Gentler still." });
    // FIELD FOR FIELD with BrandVoiceState, the writer's own answer, so what the
    // writer reports and what the reader then returns are the same five values
    // under the same names (the id is `connectionId` on the state, `id` here).
    const { connectionId, ...stateVoices } = (write.data as { state: Record<string, unknown> }).state;
    const { id, ...readVoices } = after;
    expect(connectionId).toBe(id);
    expect(stateVoices).toEqual(readVoices);
  });

  it("intelligence_context returns exactly the three fields its writer section takes", async () => {
    const { tokens } = await seed();
    const { data } = await readSettings(tokens[MINE]);
    const context = data.intelligence_context as Record<string, unknown>;
    // FIELD FOR FIELD with IntelligenceContextState, so read-then-write
    // round-trips rather than approximately round-trips.
    expect(Object.keys(context).sort()).toEqual([
      "merchantIndustry",
      "merchantMrrSelfReportedCents",
      "primaryCustomerType",
    ]);
    expect(context.merchantIndustry).toBe(FIXTURES[MINE].industry);
    expect(context.primaryCustomerType).toBe(FIXTURES[MINE].customerType);
    expect(context.merchantMrrSelfReportedCents).toBe(FIXTURES[MINE].mrrCents);
  });

  it("intelligence_context round-trips: changing the industry leaves the other two alone", async () => {
    const { tokens } = await seed();
    const before = (await readSettings(tokens[MINE])).data.intelligence_context as Record<string, unknown>;
    const write = await callTool(tokens[MINE], WRITE, {
      intelligence_context: { merchant_industry: "observatory supplies" },
    });
    expect(write.isError, write.text).toBe(false);
    const after = (await readSettings(tokens[MINE])).data.intelligence_context;
    expect(after).toEqual({ ...before, merchantIndustry: "observatory supplies" });
    // The writer's state and the next read are the same object, key for key.
    expect((write.data as { state: unknown }).state).toEqual(after);
  });

  it("the account row is NOT what comes back, so a wide reader stays narrow", async () => {
    const { tokens } = await seed();
    const { data, text } = await readSettings(tokens[MINE]);
    // Wrapping `getAccount` wholesale would have handed a third-party agent the
    // whole accounts row to expose a few fields of it. The reader is a fixed set
    // of sections, each a projection.
    expect(Object.keys(data).sort()).toEqual([
      "audit",
      "brand_voice",
      "connections",
      "features",
      "intelligence_context",
      "notifications",
      "sender",
    ]);
    expect(text).not.toContain("currency");
    expect(text).not.toContain("createdAt");
  });
});

describe("PLANT 2: the two-account pin, on a fixture that can actually fail", () => {
  it("key A reads its own voice and never account B's", async () => {
    const { tokens } = await seed();
    const mine = await readSettings(tokens[MINE]);
    const theirs = await readSettings(tokens[THEIRS]);

    expect(mine.text).toContain(FIXTURES[MINE].voice);
    expect(mine.text, "read the other account's voice").not.toContain(FIXTURES[THEIRS].voice);
    expect(mine.text, "read the other account's connection").not.toContain(`sc_${THEIRS}`);
    // AND THE OTHER KEY ANSWERS DIFFERENTLY, which is what proves the scoping is
    // real rather than proving the fixture is empty.
    expect(theirs.text).toContain(FIXTURES[THEIRS].voice);
    expect(theirs.text).not.toContain(FIXTURES[MINE].voice);
  });

  it("key A reads its own context and never account B's", async () => {
    const { tokens } = await seed();
    const mine = await readSettings(tokens[MINE]);
    const theirs = await readSettings(tokens[THEIRS]);

    expect(mine.text).toContain(FIXTURES[MINE].industry);
    expect(mine.text, "read the other account's industry").not.toContain(FIXTURES[THEIRS].industry);
    expect(mine.text, "read the other account's MRR").not.toContain("99900");
    expect(theirs.text).toContain(FIXTURES[THEIRS].industry);
    expect(theirs.text).not.toContain(FIXTURES[MINE].industry);
  });

  it("THE READER DOES NOT HONOUR AN ACCOUNT ARGUMENT, on every spelling", async () => {
    const { tokens } = await seed();
    // 372 binding 1: the key IS the account. Driven with the spellings an agent
    // would plausibly try, because the risk is not the schema, it is an executor
    // that reads an argument the schema never declared. readSettings asserts the
    // call was answered, and the positive check below proves it was answered
    // for MINE, so a refusal before the executor cannot pass this vacuously.
    for (const key of ["account_id", "accountId", "account"]) {
      const { text } = await readSettings(tokens[MINE], { [key]: THEIRS });
      expect(text, `${READ} ignored ${key} but lost its own account`).toContain(FIXTURES[MINE].voice);
      expect(text, `${READ} honoured ${key}`).not.toContain(FIXTURES[THEIRS].voice);
      expect(text, `${READ} honoured ${key}`).not.toContain(FIXTURES[THEIRS].industry);
      expect(text, `${READ} honoured ${key}`).not.toContain(`sc_${THEIRS}`);
    }
  });

  it("neither the reader nor its two writer sections DECLARES an account argument", () => {
    const read = MERCHANT_TOOLS.get(READ);
    expect(read, `${READ} is not registered`).not.toBeNull();
    expect(Object.keys(read!.inputSchema.properties ?? {})).toEqual([]);

    const write = MERCHANT_TOOLS.get(WRITE);
    expect(write, `${WRITE} is not registered`).not.toBeNull();
    const sections = write!.inputSchema.properties ?? {};
    expect(Object.keys(sections).some((k) => /account/i.test(k))).toBe(false);
    for (const section of ["brand_voice", "intelligence_context"]) {
      const props = (sections[section] as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props).some((k) => /account/i.test(k)), `${section} declares an account`).toBe(false);
    }
  });
});

describe("PLANT 3: the empty and severed cases are null, not a stale row", () => {
  it("a DISCONNECTED primary reads null, because is_primary survives disconnection", async () => {
    // 333: S37 leaves is_primary SET on a disconnected row, so a reader without
    // the null check would hand an agent a severed connection to write to.
    const { tokens } = await seed({ disconnectMine: true });
    const { data, text } = await readSettings(tokens[MINE]);
    expect(data.brand_voice).toBeNull();
    // The connections list still names the severed row (with its
    // disconnectedAt), which is right: it carries no voice text, so the voice
    // must not appear anywhere in the answer.
    expect(text).not.toContain(FIXTURES[MINE].voice);
  });

  it("an account with no connection at all reads null rather than failing", async () => {
    const { db, tokens } = await seed();
    await db.delete(stripeConnections);
    const { status, data } = await readSettings(tokens[MINE]);
    // A tool error here would teach an agent that a merchant who has not
    // connected Stripe is a broken merchant.
    expect(status).toBe(200);
    expect(data.brand_voice).toBeNull();
    // The context lives on the account row, not the connection, so it is
    // still there for a merchant who has not connected yet.
    expect((data.intelligence_context as Record<string, unknown>).merchantIndustry).toBe(FIXTURES[MINE].industry);
  });
});

describe("PLANT 4: the wider reader never returns the Slack webhook URL", () => {
  it("a set webhook reads as configured, and its URL is nowhere in the response bytes", async () => {
    const { tokens } = await seed();
    const { data, text } = await readSettings(tokens[MINE]);
    const notifications = data.notifications as Record<string, unknown>;
    // CONFIGURED IS TRUE, which is what makes the absence check discriminate:
    // the reader saw the column, so the URL being absent is the projection
    // working rather than the fixture being empty.
    expect(notifications.slackWebhookConfigured).toBe(true);
    expect(text).not.toContain(FIXTURES[MINE].slackWebhookUrl);
    expect(text).not.toContain("zanzibarQuokkaSecret");
    expect(text).not.toContain("hooks.slack.com");
    expect(text).not.toContain("slackWebhookUrl");
  });

  it("an account with no webhook reads as not configured", async () => {
    const { tokens } = await seed();
    const { data } = await readSettings(tokens[THEIRS]);
    expect((data.notifications as Record<string, unknown>).slackWebhookConfigured).toBe(false);
  });
});
