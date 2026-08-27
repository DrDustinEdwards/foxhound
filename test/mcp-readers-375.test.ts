import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 83: THE TWO READERS 375 APPROVED.
//
// WHY THEY EXIST. Sessions 79 and 80 shipped `set_brand_voice` and
// `set_intelligence_context` with no way to read either back, so an agent asked
// to soften one voice had to send all five or guess, and an agent asked to
// correct the industry had to overwrite the two fields beside it blind. 375
// approved both readers with the read discipline of 77 and said they ride with
// the next MCP-adjacent session, which is this one.
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
const ORIGIN = "https://foxhoundapp.test";

/** Distinctive on both sides, so a leak returns the OTHER account's sentence
 *  rather than an empty string that an absence check would wave through. */
const FIXTURES = {
  [MINE]: {
    voice: "Warm, plainspoken, never pushy.",
    industry: "artisanal telescope repair",
    customerType: "hobbyists",
    mrrCents: 412_00,
  },
  [THEIRS]: {
    voice: "Terse, clinical, faintly threatening.",
    industry: "industrial abrasives",
    customerType: "procurement departments",
    mrrCents: 999_00,
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
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env(),
    MERCHANT_TOOLS,
  )) as Response;
  const text = await res.text();
  return {
    status: res.status,
    text,
    data: (JSON.parse(text) as { result: { structuredContent: Record<string, unknown> } }).result
      .structuredContent,
  };
}

// ============================================================================

describe("PLANT 1: both readers are registered and readable", () => {
  it("the two names ship, and neither is a write", () => {
    expect(MERCHANT_TOOL_NAMES).toContain("get_brand_voice");
    expect(MERCHANT_TOOL_NAMES).toContain("get_intelligence_context");
  });

  it("get_brand_voice returns the five voices and the connection id set_brand_voice takes", async () => {
    const { tokens } = await seed();
    const { data } = await callTool(tokens[MINE], "get_brand_voice");
    const voices = data.voices as Record<string, unknown>;
    expect(voices.general).toBe(FIXTURES[MINE].voice);
    expect(voices.soft).toBe(`${FIXTURES[MINE].voice} SOFT`);
    expect(voices.expired).toBe(`${FIXTURES[MINE].voice} EXPIRED`);
    expect(voices.network).toBe(`${FIXTURES[MINE].voice} NETWORK`);
    expect(voices.fraud).toBe(`${FIXTURES[MINE].voice} FRAUD`);
    // The id is the half that makes the reader useful rather than merely
    // informative: set_brand_voice requires a connection id and refuses without
    // one, so a reader that withheld it would leave the echo workaround in place.
    expect(voices.id).toBe(`sc_${MINE}`);
  });

  it("get_intelligence_context returns exactly the three fields its writer takes", async () => {
    const { tokens } = await seed();
    const { data } = await callTool(tokens[MINE], "get_intelligence_context");
    const context = data.context as Record<string, unknown>;
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

  it("the account row is NOT what comes back, so a narrow reader stays narrow", async () => {
    const { tokens } = await seed();
    const { text } = await callTool(tokens[MINE], "get_intelligence_context");
    // Wrapping `getAccount` would have handed a third-party agent the whole
    // accounts row to expose three fields of it.
    expect(text).not.toContain("currency");
    expect(text).not.toContain("createdAt");
  });
});

describe("PLANT 2: the two-account pin, on a fixture that can actually fail", () => {
  it("key A reads its own voice and never account B's", async () => {
    const { tokens } = await seed();
    const mine = await callTool(tokens[MINE], "get_brand_voice");
    const theirs = await callTool(tokens[THEIRS], "get_brand_voice");

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
    const mine = await callTool(tokens[MINE], "get_intelligence_context");
    const theirs = await callTool(tokens[THEIRS], "get_intelligence_context");

    expect(mine.text).toContain(FIXTURES[MINE].industry);
    expect(mine.text, "read the other account's industry").not.toContain(FIXTURES[THEIRS].industry);
    expect(mine.text, "read the other account's MRR").not.toContain("99900");
    expect(theirs.text).toContain(FIXTURES[THEIRS].industry);
    expect(theirs.text).not.toContain(FIXTURES[MINE].industry);
  });

  it("NEITHER READER HONOURS AN ACCOUNT ARGUMENT, on every spelling", async () => {
    const { tokens } = await seed();
    // 372 binding 1: the key IS the account. Driven with the spellings an agent
    // would plausibly try, because the risk is not the schema, it is an executor
    // that reads an argument the schema never declared.
    for (const tool of ["get_brand_voice", "get_intelligence_context"]) {
      for (const key of ["account_id", "accountId", "account"]) {
        const { text } = await callTool(tokens[MINE], tool, { [key]: THEIRS });
        expect(text, `${tool} honoured ${key}`).not.toContain(FIXTURES[THEIRS].voice);
        expect(text, `${tool} honoured ${key}`).not.toContain(FIXTURES[THEIRS].industry);
        expect(text, `${tool} honoured ${key}`).not.toContain(`sc_${THEIRS}`);
      }
    }
  });

  it("neither reader DECLARES an account argument either", () => {
    for (const name of ["get_brand_voice", "get_intelligence_context"]) {
      const tool = MERCHANT_TOOLS.get(name);
      expect(tool, `${name} is not registered`).not.toBeNull();
      const properties = tool!.inputSchema.properties ?? {};
      expect(Object.keys(properties)).toEqual([]);
    }
  });
});

describe("PLANT 3: the empty and severed cases are null, not a stale row", () => {
  it("a DISCONNECTED primary reads null, because is_primary survives disconnection", async () => {
    // 333: S37 leaves is_primary SET on a disconnected row, so a reader without
    // the null check would hand an agent a severed connection to write to.
    const { tokens } = await seed({ disconnectMine: true });
    const { data, text } = await callTool(tokens[MINE], "get_brand_voice");
    expect(data.voices).toBeNull();
    expect(text).not.toContain(FIXTURES[MINE].voice);
  });

  it("an account with no connection at all reads null rather than failing", async () => {
    const { db, tokens } = await seed();
    await db.delete(stripeConnections);
    const { status, data } = await callTool(tokens[MINE], "get_brand_voice");
    // A tool error here would teach an agent that a merchant who has not
    // connected Stripe is a broken merchant.
    expect(status).toBe(200);
    expect(data.voices).toBeNull();
  });
});
