
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, alertHistory, alerts, apiKeys, mcpWrites, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

import { mcpRequest, readMcp, toolCallLogStub, confirmedCall, TEST_LINK_KEY } from "./helpers/mcp-client";
import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 80: THE FOUR SURGERIES, AND ITEM 4 CLOSES.
//
// Session 79 took the four settings whose actions were single-concern. These
// four sat inside multi-branch actions on live merchant self-service: brand
// voice, the account page's Intelligence card, and the alerts page's three
// verbs. The email page's remaining branch is the test send, which is an action
// and not a setting, so it gained no tool and keeps none.
//
// THE 2026-10-10 REGROUP folded the eight writers into two
// tools, and every property below survives the fold. set_brand_voice and
// set_intelligence_context are now the brand_voice and intelligence_context
// sections of foxhound_update_settings; create_alert and set_alert_config are
// foxhound_manage_alerts with action create, enable, disable or delete (the old
// enabled and deleted booleans are gone, replaced by the verb). Each section and
// each action still calls the same applyX the form calls.
//
// WHAT IS NEW HERE, over and above session 79's four properties:
//
//   5. OMITTING A FIELD LEAVES IT ALONE. Both of these settings are entered
//      once and forgotten, so an omission that cleared a column would be silent
//      and unrecoverable. (foxhound_get_settings now reads them back, but an
//      agent that never thought to read would still not notice the loss.)
//   6. A ZERO-ROW WRITE IS A REFUSAL, NEVER A 200. 374 binding 3. Three
//      separate places shipped with this defect and all three are pinned below,
//      each with a fixture that only the ownership check can refuse.
//   7. THE UNTOUCHED BRANCHES STAYED UNTOUCHED. The danger zone, the profile
//      field and the test send reach no tool and no apply function.
//   8. THE ACTION VERB IS CHECKED, NOT GUESSED. A verb outside the four, a
//      config verb with no alert_id and a create that names one are each
//      refused with a sentence, and none of them writes.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");
const { MERCHANT_TOOLS, MERCHANT_TOOL_NAMES, MERCHANT_WRITE_TOOL_NAMES } = await import(
  "~/lib/mcp/tools.server"
);
const { applyIntelligenceContext } = await import(
  "~/lib/settings/apply.server"
);



const MINE = "acct_mine";
const THEIRS = "acct_theirs";
const NOW = new Date("2026-08-25T12:00:00.000Z");
/** A distinctive stand-in for the encrypted access token, so the leak check
 *  below can search for it. The old fixture used "enc", which the folded
 *  tool's own section name "intelligence_context" now contains. */
const ACCESS_TOKEN = "enc-zqxjkv-access-token";

const UPDATE = "foxhound_update_settings";
const ALERTS = "foxhound_manage_alerts";

/** The eight writers item 4 shipped, by their pre-regroup names. */
const OLD_WRITE_NAMES = [
  "set_audit_settings",
  "set_feature_settings",
  "set_notification_settings",
  "set_sender_name",
  "set_brand_voice",
  "set_intelligence_context",
  "create_alert",
  "set_alert_config",
];

function env(): Env {
  return {
    DB: {},
    TOOL_CALL_LOG: toolCallLogStub(),
    EMAIL_TOKEN_KEY: TEST_LINK_KEY,
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ hit: async () => ({ ok: true, retryAfterSeconds: 60 }) }),
    },
  } as unknown as Env;
}

/**
 * Two accounts, each with a connection carrying ALL FIVE voices set, a
 * merchant context filled in, and one enabled alert with one firing recorded.
 *
 * EVERY FIELD IS SEEDED NON-EMPTY ON PURPOSE. A fixture that seeded nulls could
 * not tell "left alone" from "cleared", which is the property half this suite
 * turns on, and could not tell a cross-tenant write from a no-op.
 */
async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  const tokens: Record<string, string> = {};
  for (const account of [MINE, THEIRS]) {
    await db.insert(accounts).values({
      id: account,
      name: account,
      createdAt: NOW,
      auditLookbackDays: 90,
      auditAutoRun: false,
      merchantIndustry: `industry of ${account}`,
      primaryCustomerType: `customers of ${account}`,
      merchantMrrSelfReported: 500_000,
    });
    const token = `${MCP_TOKEN_PREFIX}${account}`;
    tokens[account] = token;
    await db.insert(apiKeys).values({
      id: `key_${account}`,
      accountId: account,
      keyHash: await hashMcpToken(token),
      label: "agent",
      scope: MCP_TOKEN_SCOPE.MERCHANT,
      // A key that may change the account, as one made in Settings.
      scopes: ["merchant.read", "merchant.write"],
      createdAt: NOW,
    });
    await db.insert(stripeConnections).values({
      id: `sc_${account}`,
      accountId: account,
      stripeUserId: `acct_stripe_${account}`,
      stripeAccessToken: ACCESS_TOKEN,
      isPrimary: true,
      connectedAt: NOW,
      createdAt: NOW,
      brandVoice: `general of ${account}`,
      brandVoiceSoft: `soft of ${account}`,
      brandVoiceExpired: `expired of ${account}`,
      brandVoiceNetwork: `network of ${account}`,
      brandVoiceFraud: `fraud of ${account}`,
    });
    await db.insert(alerts).values({
      id: `al_${account}`,
      accountId: account,
      metric: "mrr_at_risk_cents",
      direction: "above",
      thresholdValue: 100_000,
      channel: "email",
      label: `alert of ${account}`,
      enabled: true,
      createdAt: NOW,
    });
    await db.insert(alertHistory).values({
      id: `ah_${account}`,
      alertId: `al_${account}`,
      accountId: account,
      metric: "mrr_at_risk_cents",
      direction: "above",
      thresholdValue: 100_000,
      actualValue: 200_000,
      channel: "email",
      firedAt: NOW,
    });
  }
  return { db, tokens };
}

/** One tools/call through the real handler, the SDK and the registry. */
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = (await confirmedCall((a) => handleMcpRequest(mcpRequest({ token, method: "tools/call", params: { name, arguments: a } }), env(), MERCHANT_TOOLS), args));
  const answer = await readMcp(res);
  return { status: answer.status, text: answer.text, json: answer.json as never };
}

/** One foxhound_update_settings call carrying exactly one section. */
const updateSettings = (token: string, section: string, body: Record<string, unknown>) =>
  callTool(token, UPDATE, { [section]: body });

/** One foxhound_manage_alerts call. */
const manageAlerts = (token: string, args: Record<string, unknown>) => callTool(token, ALERTS, args);

const resultOf = (json: never) =>
  (json as unknown as {
    result: { isError?: boolean; structuredContent: Record<string, unknown> };
  }).result;

const connectionOf = async (db: Awaited<ReturnType<typeof seed>>["db"], account: string) =>
  (await db.select().from(stripeConnections).where(eq(stripeConnections.id, `sc_${account}`)))[0];


// ============================================================================

describe("PLANT 1: item 4 is closed, its eight writers folded into two tools", () => {
  it("the two write tools, named, and none of the eight old names survives", () => {
    expect(MERCHANT_WRITE_TOOL_NAMES).toEqual([UPDATE, ALERTS]);
    // THE WRITE HALF IS THE PIN, not the total. A total pinned at a number
    // would go red for a read tool item 4 has no opinion about, which is how a
    // count guard teaches people to edit the number rather than read the
    // assertion.
    expect(MERCHANT_WRITE_TOOL_NAMES).toHaveLength(2);
    for (const old of OLD_WRITE_NAMES) expect(MERCHANT_TOOL_NAMES).not.toContain(old);
  });
});

describe("PLANT 2: a write lands on the caller's account and nowhere else", () => {
  it("brand_voice changes MINE and leaves THEIRS at every seeded value", async () => {
    const { db, tokens } = await seed();
    const { status, json } = await updateSettings(tokens[MINE], "brand_voice", {
      connection_id: `sc_${MINE}`,
      general: "Warm and direct",
      soft: "Gentle",
      expired: "Brisk",
      network: "Plain",
      fraud: "Formal",
    });
    expect(status).toBe(200);
    expect(resultOf(json).isError).toBeUndefined();

    const mine = await connectionOf(db, MINE);
    expect(mine.brandVoice).toBe("Warm and direct");
    expect(mine.brandVoiceSoft).toBe("Gentle");
    expect(mine.brandVoiceFraud).toBe("Formal");

    const theirs = await connectionOf(db, THEIRS);
    expect(theirs.brandVoice).toBe(`general of ${THEIRS}`);
    expect(theirs.brandVoiceSoft).toBe(`soft of ${THEIRS}`);
    expect(theirs.brandVoiceFraud).toBe(`fraud of ${THEIRS}`);
  });

  it("intelligence_context changes MINE and leaves THEIRS alone", async () => {
    const { db, tokens } = await seed();
    const { json } = await updateSettings(tokens[MINE], "intelligence_context", {
      merchant_industry: "B2B SaaS",
      primary_customer_type: "small businesses",
      merchant_mrr_self_reported: 12_500,
    });
    expect(resultOf(json).isError).toBeUndefined();
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    const theirs = (await db.select().from(accounts).where(eq(accounts.id, THEIRS)))[0];
    expect(mine.merchantIndustry).toBe("B2B SaaS");
    expect(mine.primaryCustomerType).toBe("small businesses");
    // Dollars in, cents stored, which is the column the rest of the app reads.
    expect(mine.merchantMrrSelfReported).toBe(1_250_000);
    expect(theirs.merchantIndustry).toBe(`industry of ${THEIRS}`);
    expect(theirs.merchantMrrSelfReported).toBe(500_000);
  });

  it("action disable turns MINE's alert off and leaves THEIRS enabled", async () => {
    const { db, tokens } = await seed();
    const { json } = await manageAlerts(tokens[MINE], { action: "disable", alert_id: `al_${MINE}` });
    expect(resultOf(json).isError).toBeUndefined();
    const mine = (await db.select().from(alerts).where(eq(alerts.id, `al_${MINE}`)))[0];
    const theirs = (await db.select().from(alerts).where(eq(alerts.id, `al_${THEIRS}`)))[0];
    expect(mine.enabled).toBe(false);
    expect(theirs.enabled).toBe(true);
  });

  it("and action enable turns it back on, so the verb and not a default decides", async () => {
    // The positive control for disable: a verb that always wrote false would
    // pass the plant above.
    const { db, tokens } = await seed();
    await manageAlerts(tokens[MINE], { action: "disable", alert_id: `al_${MINE}` });
    const { json } = await manageAlerts(tokens[MINE], { action: "enable", alert_id: `al_${MINE}` });
    expect(resultOf(json).isError).toBeUndefined();
    expect(resultOf(json).structuredContent.state).toEqual({
      id: `al_${MINE}`,
      enabled: true,
      deleted: false,
    });
    const mine = (await db.select().from(alerts).where(eq(alerts.id, `al_${MINE}`)))[0];
    expect(mine.enabled).toBe(true);
  });
});

describe("PLANT 3b: the action verb is checked, and a wrong shape writes nothing", () => {
  it("an action outside the four is refused, writes nothing, and the verbs are listed", async () => {
    // ON THE WIRE the schema's enum refuses it in the SDK before the executor
    // runs, and the SDK's sentence names the argument but not the verbs. The
    // verbs reach the agent through tools/list (the enum, asserted in PLANT 1)
    // and through the executor's own guard, which a client that skips schema
    // validation reaches and which is driven directly below.
    const { db, tokens } = await seed();
    const { json } = await manageAlerts(tokens[MINE], { action: "pause", alert_id: `al_${MINE}` });
    const result = resultOf(json);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("action");

    const mine = (await db.select().from(alerts).where(eq(alerts.id, `al_${MINE}`)))[0];
    expect(mine.enabled).toBe(true);
    expect(await db.select().from(mcpWrites)).toHaveLength(0);

    // The executor's guard, behind the validator: a sentence listing all four.
    const tool = MERCHANT_TOOLS.get(ALERTS)!;
    await expect(
      tool.execute(
        {
          env: env(),
          db,
          accountId: MINE,
          now: NOW,
          trace: { apiKeyId: `key_${MINE}`, tool: ALERTS, now: NOW },
        } as Parameters<typeof tool.execute>[0],
        { action: "pause", alert_id: `al_${MINE}` },
      ),
    ).rejects.toThrow("action must be one of create, enable, disable, delete.");
    expect((await db.select().from(alerts).where(eq(alerts.id, `al_${MINE}`)))[0].enabled).toBe(true);
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("enable, disable and delete without alert_id are each refused, naming the argument", async () => {
    const { db, tokens } = await seed();
    for (const action of ["enable", "disable", "delete"]) {
      const { json } = await manageAlerts(tokens[MINE], { action });
      const result = resultOf(json);
      expect(result.isError, `${action} with no alert_id`).toBe(true);
      expect(JSON.stringify(result)).toContain("alert_id");
    }
    // Nothing on either account moved.
    for (const account of [MINE, THEIRS]) {
      const row = (await db.select().from(alerts).where(eq(alerts.id, `al_${account}`)))[0];
      expect(row.enabled).toBe(true);
    }
    expect(await db.select().from(alertHistory)).toHaveLength(2);
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("create with an alert_id is refused, so a misread verb cannot create a duplicate", async () => {
    // An agent that meant to change al_mine and sent create would otherwise
    // get a second alert and a success.
    const { db, tokens } = await seed();
    const { json } = await manageAlerts(tokens[MINE], {
      action: "create",
      alert_id: `al_${MINE}`,
      metric: "high_risk_customers_count",
      direction: "below",
      threshold: 30,
    });
    const result = resultOf(json);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("takes no alert_id");
    expect(await db.select().from(alerts).where(eq(alerts.accountId, MINE))).toHaveLength(1);
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });
});

describe("PLANT 4: omitting a field leaves it alone, clearing it clears it", () => {

  it("and an EMPTY STRING clears an intelligence_context field through the tool", async () => {
    // The tool-side positive control for the omission plant above, on this
    // section: "" reaches the column as null, the others stay.
    const { db, tokens } = await seed();
    await updateSettings(tokens[MINE], "intelligence_context", { primary_customer_type: "" });
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(mine.primaryCustomerType).toBeNull();
    expect(mine.merchantIndustry).toBe(`industry of ${MINE}`);
    expect(mine.merchantMrrSelfReported).toBe(500_000);
  });
});

describe("PLANT 5: validator parity, over the shared function", () => {
  it("a metric the evaluator cannot compute is refused, in the form's words", async () => {
    const { tokens } = await seed();
    const { json } = await manageAlerts(tokens[MINE], {
      action: "create",
      metric: "health_score_avg",
      direction: "above",
      threshold: 10,
    });
    const result = resultOf(json);
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe("Choose a metric Foxhound tracks.");
  });

  it("BLANK still clears it, because clearing is a real thing to want", async () => {
    const { db } = await seed();
    const result = await applyIntelligenceContext(db, MINE, { merchantMrrSelfReported: "" });
    expect(result.ok).toBe(true);
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(mine.merchantMrrSelfReported).toBeNull();
  });
});

describe("PLANT 6: every write leaves a trace, naming fields and never values", () => {
  it("each write leaves one row carrying the key id, the tool and the fields it sent", async () => {
    const { db, tokens } = await seed();
    // Each call's row is read as the one row it added, so the fields are
    // pinned to the call that wrote them rather than matched up afterwards.
    const traced: { tool: string; fields: string[]; apiKeyId: string }[] = [];
    const traceOf = async (call: () => Promise<unknown>) => {
      const before = new Set((await db.select().from(mcpWrites)).map((r) => r.id));
      await call();
      const added = (await db.select().from(mcpWrites)).filter((r) => !before.has(r.id));
      expect(added).toHaveLength(1);
      const row = added[0];
      traced.push({ tool: row.tool, fields: row.fields as string[], apiKeyId: row.apiKeyId! });
      return row;
    };

    const voice = await traceOf(() =>
      updateSettings(tokens[MINE], "brand_voice", { connection_id: `sc_${MINE}`, general: "Warm" }),
    );
    const context = await traceOf(() =>
      updateSettings(tokens[MINE], "intelligence_context", { merchant_industry: "Fintech" }),
    );
    const created = await traceOf(() =>
      manageAlerts(tokens[MINE], {
        action: "create",
        metric: "high_risk_customers_count",
        direction: "below",
        threshold: 30,
      }),
    );
    const disabled = await traceOf(() =>
      manageAlerts(tokens[MINE], { action: "disable", alert_id: `al_${MINE}` }),
    );

    // THE TRACE NAMES THE TOOL THAT RAN, which is now the folded tool, not
    // the section or the verb.
    expect(traced.map((t) => t.tool)).toEqual([UPDATE, UPDATE, ALERTS, ALERTS]);
    for (const row of traced) expect(row.apiKeyId).toBe(`key_${MINE}`);
    expect(await db.select().from(mcpWrites).where(eq(mcpWrites.accountId, MINE))).toHaveLength(4);

    // FIELD NAMES, and only the columns the caller actually supplied.
    expect(voice.fields).toEqual(["brand_voice"]);
    expect(context.fields).toEqual(["merchant_industry"]);
    expect(created.fields).toEqual(["metric", "direction", "threshold_value", "label", "channel"]);
    expect(disabled.fields).toEqual(["enabled"]);
  });

  it("a delete leaves its own trace too, naming the delete", async () => {
    const { db, tokens } = await seed();
    await manageAlerts(tokens[MINE], { action: "delete", alert_id: `al_${MINE}` });
    const rows = await db.select().from(mcpWrites);
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe(ALERTS);
    expect(rows[0].fields).toEqual(["deleted"]);
  });
});

describe("PLANT 9: a destructive call is confirmed first, by a code tied to that exact call (area 11, T11)", () => {
  it("the first call deletes nothing, another call's code is refused, and the matching code deletes", async () => {
    const { db, tokens } = await seed();
    const send = async (args: Record<string, unknown>) =>
      resultOf(
        (await readMcp((await handleMcpRequest(
          mcpRequest({ token: tokens[MINE], method: "tools/call", params: { name: ALERTS, arguments: args } }),
          env(),
          MERCHANT_TOOLS,
        )) as Response)).json as never,
      );
    const asked = await send({ action: "delete", alert_id: `al_${MINE}` });
    expect(asked.structuredContent).toMatchObject({ confirmation_required: true });
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
    // A code for one alert does not delete another.
    const other = await send({ action: "delete", alert_id: `al_${THEIRS}`, confirm: asked.structuredContent.confirm });
    expect(other.structuredContent).toMatchObject({ confirmation_required: true });
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
    const done = await send({ action: "delete", alert_id: `al_${MINE}`, confirm: asked.structuredContent.confirm });
    expect(done.structuredContent).toMatchObject({ action: "delete" });
    expect(await db.select().from(mcpWrites)).toHaveLength(1);
  });
});

describe("PLANT 8: the demo account is refused at the gate, before any tool runs", () => {
  it("a merchant key on a demo account gets the byte-stable 401 and writes nothing", async () => {
    const { db } = await seed();
    // The firewall is on the account id prefix, so a demo account is seeded as
    // one rather than described as one.
    await db.insert(accounts).values({
      id: "demo_acct",
      name: "demo",
      createdAt: NOW,
      auditLookbackDays: 90,
      auditAutoRun: false,
    });
    const token = `${MCP_TOKEN_PREFIX}demo`;
    await db.insert(apiKeys).values({
      id: "key_demo",
      accountId: "demo_acct",
      keyHash: await hashMcpToken(token),
      label: "agent",
      scope: MCP_TOKEN_SCOPE.MERCHANT,
      createdAt: NOW,
    });

    const { status, text } = await updateSettings(token, "brand_voice", {
      connection_id: "sc_demo",
      general: "Whatever",
    });
    expect(status).toBe(401);
    expect(text).toBe(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Unauthorized"}}',
    );
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });
});
