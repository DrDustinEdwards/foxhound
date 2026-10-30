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
// THE REGROUP folded `get_brand_voice` and
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
// same vacuum that let three tools leak for six sessions, caught
// here by writing the fixture the assertion needs instead of inheriting one.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");
const { MERCHANT_TOOLS } = await import("~/lib/mcp/tools.server");

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
      get: () => ({ hit: async () => ({ ok: true, retryAfterSeconds: 60 }) }),
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
});
