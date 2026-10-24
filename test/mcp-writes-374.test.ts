import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, alertHistory, alerts, apiKeys, mcpWrites, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { isDeniedToolName } from "~/lib/mcp/registry";

import { mcpRequest, readMcp } from "./helpers/mcp-client";
import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 80: THE FOUR SURGERIES, AND ITEM 4 CLOSES (372, 374).
//
// Session 79 took the four settings whose actions were single-concern. These
// four sat inside multi-branch actions on live merchant self-service: brand
// voice, the account page's Intelligence card, and the alerts page's three
// verbs. The email page's remaining branch is the test send, which is an action
// and not a setting, so it gained no tool and keeps none.
//
// THE 2026-10-10 REGROUP (job_874dc20ea9ac) folded the eight writers into two
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
const { applyBrandVoice, applyIntelligenceContext, applyAlertConfig, MRR_ERROR } = await import(
  "~/lib/settings/apply.server"
);

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

/** Comments stripped before any absence grep. Session 57's trap, walked into
 *  twice in this campaign: these routes DISCUSS the names being forbidden. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

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
  const res = (await handleMcpRequest(
    mcpRequest({ token, method: "tools/call", params: { name, arguments: args } }),
    env(),
    MERCHANT_TOOLS,
  )) as Response;
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

const descriptorOf = (name: string) => MERCHANT_TOOLS.list().find((d) => d.name === name)!;

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

  it("and the eight are all still reachable, as six sections and four verbs", () => {
    // The fold must not have dropped a writer on the way. Six settings
    // sections cover the six settings writers; the four verbs cover
    // create_alert and set_alert_config's enable, disable and delete.
    const sections = Object.keys(descriptorOf(UPDATE).inputSchema.properties ?? {});
    expect(sections).toEqual([
      "audit",
      "features",
      "notifications",
      "sender_name",
      "brand_voice",
      "intelligence_context",
    ]);
    const action = (descriptorOf(ALERTS).inputSchema.properties ?? {}).action as { enum: string[] };
    expect(action.enum).toEqual(["create", "enable", "disable", "delete"]);
  });

  it("THERE IS NO email SECTION, and the reason is not an omission", () => {
    // 370's Table 6 sized the eight by ACTION rather than by concern, and its
    // eighth row was "email, whole". The email page writes exactly one column,
    // `sender_name`, which shipped in session 79 and is now the sender_name
    // section; the only branch left on that action is the test send, which is
    // an action and not a setting. An email section would therefore have been
    // either a second name for sender_name or a section with no form behind
    // it, and both are the drift the apply layer exists to prevent.
    const sections = Object.keys(descriptorOf(UPDATE).inputSchema.properties ?? {});
    expect(sections).not.toContain("email");
    expect(sections).toContain("sender_name");
    expect(MERCHANT_TOOL_NAMES).not.toContain("set_email_settings");
    // And the test send is reachable from the form and from nowhere else.
    expect(code(read("app/lib/mcp/tools.server.ts"))).not.toContain("sendTestEmail");
    expect(code(read("app/lib/settings/apply.server.ts"))).not.toContain("sendTestEmail");
    expect(code(read("app/routes/app/settings/email.tsx"))).toContain("sendTestEmail(");
  });

  it("THE HUMAN-FOREVER FIVE ARE STILL ABSENT, beside the writes", () => {
    for (const name of [
      "submit_dispute_evidence",
      "cancel_account",
      "disconnect_stripe",
      "connect_stripe",
      "create_api_key",
      "record_outcome",
    ]) {
      expect(MERCHANT_TOOL_NAMES).not.toContain(name);
      expect(isDeniedToolName(name), `${name} would be registrable`).toBe(true);
    }
    // The account page still carries the cancel branch, so the absence above is
    // a refusal to expose it rather than the feature having quietly gone.
    expect(code(read("app/routes/app/settings/account.tsx"))).toContain("cancelMerchant(");
  });

  it("and every write name clears the denylist by construction", () => {
    for (const name of MERCHANT_WRITE_TOOL_NAMES) {
      expect(isDeniedToolName(name), `${name} is denied`).toBe(false);
    }
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

  it("action create writes one row on MINE and THEIRS still has exactly its own", async () => {
    const { db, tokens } = await seed();
    const { json } = await manageAlerts(tokens[MINE], {
      action: "create",
      metric: "mrr_churn_cents",
      direction: "above",
      threshold: 750,
      label: "Churn watch",
    });
    expect(resultOf(json).isError).toBeUndefined();
    expect(resultOf(json).structuredContent.action).toBe("create");

    const mineRows = await db.select().from(alerts).where(eq(alerts.accountId, MINE));
    const theirRows = await db.select().from(alerts).where(eq(alerts.accountId, THEIRS));
    expect(mineRows).toHaveLength(2);
    expect(theirRows).toHaveLength(1);
    const created = mineRows.find((r) => r.label === "Churn watch")!;
    // A cents metric took dollars and stored cents.
    expect(created.thresholdValue).toBe(75_000);
    expect(created.enabled).toBe(true);
  });

  it("a NON-cents metric is stored as the plain number it is", async () => {
    // The positive control for the conversion above: without it, "stores cents"
    // could be "multiplies everything by a hundred".
    const { db, tokens } = await seed();
    await manageAlerts(tokens[MINE], {
      action: "create",
      metric: "health_score_avg",
      direction: "below",
      threshold: 40,
      label: "Health floor",
    });
    const created = (await db.select().from(alerts).where(eq(alerts.accountId, MINE))).find(
      (r) => r.label === "Health floor",
    )!;
    expect(created.thresholdValue).toBe(40);
  });

  it("SET THEN GET: an alert created through the tool comes back from foxhound_get_intelligence", async () => {
    const { tokens } = await seed();
    await manageAlerts(tokens[MINE], {
      action: "create",
      metric: "mrr_at_risk_cents",
      direction: "above",
      threshold: 1_000,
      label: "Risk watch",
    });
    const { json } = await callTool(tokens[MINE], "foxhound_get_intelligence");
    const view = resultOf(json).structuredContent as { alerts: { label: string | null }[] };
    expect(view.alerts.map((a) => a.label)).toContain("Risk watch");
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

  it("action delete takes the alert's own firing history and NOTHING of the other account's", async () => {
    const { db, tokens } = await seed();
    const { json } = await manageAlerts(tokens[MINE], { action: "delete", alert_id: `al_${MINE}` });
    expect(resultOf(json).isError).toBeUndefined();
    expect(await db.select().from(alerts).where(eq(alerts.id, `al_${MINE}`))).toHaveLength(0);
    expect(await db.select().from(alertHistory).where(eq(alertHistory.alertId, `al_${MINE}`)))
      .toHaveLength(0);
    // The foreign key would have refused the delete if the history had gone
    // second, so this also pins the batch ORDER, not only the cascade.
    expect(await db.select().from(alerts).where(eq(alerts.id, `al_${THEIRS}`))).toHaveLength(1);
    expect(await db.select().from(alertHistory).where(eq(alertHistory.alertId, `al_${THEIRS}`)))
      .toHaveLength(1);
  });
});

describe("PLANT 3: the zero-row write refuses, and never answers 200", () => {
  it("brand_voice REFUSES a connection belonging to the other account", async () => {
    // THE STACKED-GUARD FIXTURE: a REAL, EXISTING connection id owned by
    // somebody else. A nonexistent id would be refused by any check at all,
    // including one that only asked whether the row existed, so only an
    // ownership check can produce this refusal.
    const { db, tokens } = await seed();
    const { json } = await updateSettings(tokens[MINE], "brand_voice", {
      connection_id: `sc_${THEIRS}`,
      general: "HIJACKED",
    });
    expect(resultOf(json).isError).toBe(true);
    expect(resultOf(json).structuredContent.tool).toBe(UPDATE);

    const theirs = await connectionOf(db, THEIRS);
    expect(theirs.brandVoice).toBe(`general of ${THEIRS}`);
    // And no trace row, because a refused write leaves neither half.
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("manage_alerts REFUSES the other account's alert, for all three config verbs", async () => {
    const { db, tokens } = await seed();
    for (const action of ["disable", "enable", "delete"]) {
      const { json } = await manageAlerts(tokens[MINE], { action, alert_id: `al_${THEIRS}` });
      expect(resultOf(json).isError, `${action} on a foreign alert`).toBe(true);
      // The form's sentence, word for word, so a foreign id reads as not found.
      expect(resultOf(json).structuredContent.error).toBe("Select an alert.");
    }

    const theirs = (await db.select().from(alerts).where(eq(alerts.id, `al_${THEIRS}`)))[0];
    expect(theirs.enabled).toBe(true);
    expect(await db.select().from(alertHistory).where(eq(alertHistory.alertId, `al_${THEIRS}`)))
      .toHaveLength(1);
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("an alert id that exists nowhere refuses too, with the same sentence", async () => {
    const { db } = await seed();
    const result = await applyAlertConfig(db, MINE, { alertId: "al_nope", enabled: false });
    expect(result).toEqual({ ok: false, error: "Select an alert." });
  });

  it("THE OLD BEHAVIOUR IS GONE: the UPDATE itself still matches zero rows", async () => {
    // The guard is what refuses, and this is why it had to exist. The writer's
    // account-pinned WHERE is unchanged and correct; it simply cannot tell the
    // caller that it matched nothing, which is how "changed nothing" was
    // reported as success for three shipped verbs.
    const { db } = await seed();
    const { buildAlertEnabledUpdate } = await import("~/lib/settings/alerts.server");
    await buildAlertEnabledUpdate(db, MINE, `al_${THEIRS}`, false);
    const theirs = (await db.select().from(alerts).where(eq(alerts.id, `al_${THEIRS}`)))[0];
    expect(theirs.enabled).toBe(true);
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
      metric: "health_score_avg",
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
  it("brand_voice with only the general voice does not wipe the four categories", async () => {
    const { db, tokens } = await seed();
    await updateSettings(tokens[MINE], "brand_voice", {
      connection_id: `sc_${MINE}`,
      general: "Only this one",
    });
    const mine = await connectionOf(db, MINE);
    expect(mine.brandVoice).toBe("Only this one");
    expect(mine.brandVoiceSoft).toBe(`soft of ${MINE}`);
    expect(mine.brandVoiceExpired).toBe(`expired of ${MINE}`);
    expect(mine.brandVoiceNetwork).toBe(`network of ${MINE}`);
    expect(mine.brandVoiceFraud).toBe(`fraud of ${MINE}`);
  });

  it("but an EMPTY STRING is a real instruction and clears that one column", async () => {
    // The other half of the rule. Without this, "leaves it alone" could be
    // "never writes null", and clearing a voice back to the general one is a
    // thing the form has always been able to do.
    const { db, tokens } = await seed();
    await updateSettings(tokens[MINE], "brand_voice", {
      connection_id: `sc_${MINE}`,
      soft: "",
    });
    const mine = await connectionOf(db, MINE);
    expect(mine.brandVoiceSoft).toBeNull();
    expect(mine.brandVoice).toBe(`general of ${MINE}`);
    expect(mine.brandVoiceExpired).toBe(`expired of ${MINE}`);
  });

  it("intelligence_context follows the same rule on its three fields", async () => {
    const { db, tokens } = await seed();
    await updateSettings(tokens[MINE], "intelligence_context", { merchant_industry: "Fintech" });
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(mine.merchantIndustry).toBe("Fintech");
    expect(mine.primaryCustomerType).toBe(`customers of ${MINE}`);
    expect(mine.merchantMrrSelfReported).toBe(500_000);
  });

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

  it("THE FORM SUPPLIES EVERY KEY, so nothing about its behaviour changed", async () => {
    // The rule only fires on an omission, and the forms omit nothing: they post
    // hidden and empty inputs alike. Driven through the apply layer with the
    // form's own call shape, where "" means clear.
    const { db } = await seed();
    const result = await applyBrandVoice(db, MINE, {
      connectionId: `sc_${MINE}`,
      general: "",
      soft: "",
      expired: "",
      network: "",
      fraud: "",
    });
    expect(result.ok).toBe(true);
    const mine = await connectionOf(db, MINE);
    expect([
      mine.brandVoice,
      mine.brandVoiceSoft,
      mine.brandVoiceExpired,
      mine.brandVoiceNetwork,
      mine.brandVoiceFraud,
    ]).toEqual([null, null, null, null, null]);
  });
});

describe("PLANT 5: validator parity, over the shared function", () => {
  it("a metric the nightly evaluator cannot compute is refused, in the form's words", async () => {
    const { tokens } = await seed();
    const { json } = await manageAlerts(tokens[MINE], {
      action: "create",
      metric: "recovery_rate_pct",
      direction: "above",
      threshold: 10,
    });
    const result = resultOf(json);
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe("Choose a metric Foxhound tracks.");
  });

  it("a negative threshold is refused, in the form's words", async () => {
    const { tokens } = await seed();
    const { json } = await manageAlerts(tokens[MINE], {
      action: "create",
      metric: "health_score_avg",
      direction: "below",
      threshold: -1,
    });
    const result = resultOf(json);
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe("Enter a threshold of zero or more.");
  });

  it("an amount that is not a number is refused rather than silently stored as null", async () => {
    // THE DEFECT THIS SESSION FOUND ON A HUMAN SURFACE. The MRR field is a
    // plain text input, so a person could always type into it and be told it
    // saved while parseDollarsToCents turned it into a null that overwrote
    // their figure. Asserted against the shipped constant so the sentence an
    // agent reads is the sentence the form shows.
    const { db, tokens } = await seed();
    const { json } = await updateSettings(tokens[MINE], "intelligence_context", {
      merchant_mrr_self_reported: "about a million",
    });
    const result = resultOf(json);
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe(MRR_ERROR);
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(mine.merchantMrrSelfReported).toBe(500_000);
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
        metric: "health_score_avg",
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
    expect(created.fields).toEqual(["metric", "direction", "threshold_value", "label"]);
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

  it("NEVER VALUES: a distinctive voice does not appear anywhere in the trace", async () => {
    const { db, tokens } = await seed();
    const secret = "zqxjkv-distinctive-voice-string";
    await updateSettings(tokens[MINE], "brand_voice", {
      connection_id: `sc_${MINE}`,
      general: secret,
    });
    // It landed in the column.
    expect((await connectionOf(db, MINE)).brandVoice).toBe(secret);
    // And nowhere in the trace, which has different readers and different
    // retention from the settings table.
    const rows = await db.select().from(mcpWrites);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("THE FORM'S OWN WRITE STILL LEAVES NO TRACE", async () => {
    const { db } = await seed();
    await applyBrandVoice(db, MINE, { connectionId: `sc_${MINE}`, general: "From a person" });
    expect((await connectionOf(db, MINE)).brandVoice).toBe("From a person");
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("and a created alert's trace is scoped to the caller's account", async () => {
    const { db, tokens } = await seed();
    await manageAlerts(tokens[THEIRS], {
      action: "create",
      metric: "health_score_avg",
      direction: "below",
      threshold: 30,
    });
    const mine = await db.select().from(mcpWrites).where(eq(mcpWrites.accountId, MINE));
    const theirs = await db.select().from(mcpWrites).where(eq(mcpWrites.accountId, THEIRS));
    expect(mine).toHaveLength(0);
    expect(theirs).toHaveLength(1);
  });
});

describe("PLANT 7: the write tools return settings, never customer data", () => {
  it("no response from the four writes carries a customer id, an email or a name field", async () => {
    // The redaction rule 370 set for the read tools is not something a write
    // tool can breach by accident, because none of them reads a customer. This
    // asserts that over the RESPONSE BYTES rather than assuming it: a state
    // echo that grew a joined row would show up here.
    const { tokens } = await seed();
    const responses = [
      await updateSettings(tokens[MINE], "brand_voice", {
        connection_id: `sc_${MINE}`,
        general: "Warm",
      }),
      await updateSettings(tokens[MINE], "intelligence_context", { merchant_industry: "Fintech" }),
      await manageAlerts(tokens[MINE], {
        action: "create",
        metric: "health_score_avg",
        direction: "below",
        threshold: 30,
      }),
      await manageAlerts(tokens[MINE], { action: "disable", alert_id: `al_${MINE}` }),
    ];
    for (const { text, json } of responses) {
      // A refused call would carry no state at all and pass vacuously.
      expect(resultOf(json).isError).toBeUndefined();
      for (const leak of ["stripeCustomerId", "customerEmail", "customerName", "@"]) {
        expect(text, `${leak} in a write response`).not.toContain(leak);
      }
      // Nor the access token that sits on the same connection row.
      expect(text).not.toContain("stripeAccessToken");
      expect(text).not.toContain(ACCESS_TOKEN);
    }
  });

  it("brand_voice echoes the state it wrote, so an agent can confirm without a second call", async () => {
    const { tokens } = await seed();
    const { json } = await updateSettings(tokens[MINE], "brand_voice", {
      connection_id: `sc_${MINE}`,
      general: "Warm",
    });
    const state = resultOf(json).structuredContent as {
      section: string;
      updated: string[];
      state: Record<string, unknown>;
    };
    expect(state.section).toBe("brand_voice");
    expect(state.updated).toEqual(["brand_voice"]);
    // The whole voice, including the four it left alone, which is the only way
    // an agent can see what it did not change from the write's own answer.
    expect(state.state).toEqual({
      connectionId: `sc_${MINE}`,
      general: "Warm",
      soft: `soft of ${MINE}`,
      expired: `expired of ${MINE}`,
      network: `network of ${MINE}`,
      fraud: `fraud of ${MINE}`,
    });
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

describe("PLANT 9: the alert delete is two statements in the order the key requires", () => {

  it("BEHAVIOURAL, not only positional: the delete succeeds against a real foreign key", async () => {
    // The structural check above would pass on a batch that never ran. This one
    // fails if the order is wrong, because SQLite refuses the parent delete
    // while a child row references it.
    const { db } = await seed();
    const result = await applyAlertConfig(db, MINE, { alertId: `al_${MINE}`, deleted: true });
    expect(result.ok).toBe(true);
    expect(
      await db
        .select()
        .from(alerts)
        .where(and(eq(alerts.id, `al_${MINE}`), eq(alerts.accountId, MINE))),
    ).toHaveLength(0);
  });
});
