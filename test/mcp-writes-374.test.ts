import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, alertHistory, alerts, apiKeys, mcpWrites, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { isDeniedToolName } from "~/lib/mcp/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 80: THE FOUR SURGERIES, AND ITEM 4 CLOSES (372, 374).
//
// Session 79 took the four settings whose actions were single-concern. These
// four sat inside multi-branch actions on live merchant self-service: brand
// voice, the account page's Intelligence card, and the alerts page's three
// verbs. The email page's remaining branch is the test send, which is an action
// and not a setting, so it gained no tool and keeps none.
//
// WHAT IS NEW HERE, over and above session 79's four properties:
//
//   5. OMITTING A FIELD LEAVES IT ALONE. Both of these settings are entered
//      once and forgotten, and neither has a read tool to restore them from, so
//      an omission that cleared a column would be silent and unrecoverable.
//   6. A ZERO-ROW WRITE IS A REFUSAL, NEVER A 200. 374 binding 3. Three
//      separate places shipped with this defect and all three are pinned below,
//      each with a fixture that only the ownership check can refuse.
//   7. THE UNTOUCHED BRANCHES STAYED UNTOUCHED. The danger zone, the profile
//      field and the test send reach no tool and no apply function.

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
const ORIGIN = "https://foxhoundapp.test";

function env(): Env {
  return {
    DB: {},
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ check: async () => ({ allowed: true, retryAfterSec: 60 }) }),
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
      stripeAccessToken: "enc",
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

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = (await handleMcpRequest(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
  return { status: res.status, text, json: JSON.parse(text) as never };
}

const resultOf = (json: never) =>
  (json as unknown as {
    result: { isError?: boolean; structuredContent: Record<string, unknown> };
  }).result;

const connectionOf = async (db: Awaited<ReturnType<typeof seed>>["db"], account: string) =>
  (await db.select().from(stripeConnections).where(eq(stripeConnections.id, `sc_${account}`)))[0];

// ============================================================================

describe("PLANT 1: item 4 is closed at eight writes, beside a read half that grows", () => {
  it("the eight, named and in the order they shipped", () => {
    expect(MERCHANT_WRITE_TOOL_NAMES).toEqual([
      "set_audit_settings",
      "set_feature_settings",
      "set_notification_settings",
      "set_sender_name",
      "set_brand_voice",
      "set_intelligence_context",
      "create_alert",
      "set_alert_config",
    ]);
    // THE WRITE HALF IS THE PIN, not the total. Session 83 added two read
    // tools and a total pinned at 21 would have gone red for a change item 4
    // has no opinion about, which is how a count guard teaches people to edit
    // the number rather than read the assertion.
    expect(MERCHANT_WRITE_TOOL_NAMES).toHaveLength(8);
  });

  it("THERE IS NO set_email_settings, and the reason is not an omission", () => {
    // 370's Table 6 sized the eight by ACTION rather than by concern, and its
    // eighth row was "email, whole". The email page writes exactly one column,
    // `sender_name`, which shipped in session 79 as set_sender_name; the only
    // branch left on that action is the test send, which is an action and not a
    // setting. A set_email_settings would therefore have been either a second
    // name for set_sender_name or a tool with no form behind it, and both are
    // the drift the apply layer exists to prevent.
    expect(MERCHANT_TOOL_NAMES).not.toContain("set_email_settings");
    expect(MERCHANT_TOOL_NAMES).toContain("set_sender_name");
    // And the test send is reachable from the form and from nowhere else.
    expect(code(read("app/lib/mcp/tools.server.ts"))).not.toContain("sendTestEmail");
    expect(code(read("app/lib/settings/apply.server.ts"))).not.toContain("sendTestEmail");
    expect(code(read("app/routes/app/settings/email.tsx"))).toContain("sendTestEmail(");
  });

  it("THE HUMAN-FOREVER FIVE ARE STILL ABSENT, on the session that added the writes", () => {
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

  it("and every new name clears the denylist by construction", () => {
    for (const name of MERCHANT_WRITE_TOOL_NAMES) {
      expect(isDeniedToolName(name), `${name} is denied`).toBe(false);
    }
  });
});

describe("PLANT 2: a write lands on the caller's account and nowhere else", () => {
  it("set_brand_voice changes MINE and leaves THEIRS at every seeded value", async () => {
    const { db, tokens } = await seed();
    const { status, json } = await callTool(tokens[MINE], "set_brand_voice", {
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

  it("set_intelligence_context changes MINE and leaves THEIRS alone", async () => {
    const { db, tokens } = await seed();
    await callTool(tokens[MINE], "set_intelligence_context", {
      merchant_industry: "B2B SaaS",
      primary_customer_type: "small businesses",
      merchant_mrr_self_reported: 12_500,
    });
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    const theirs = (await db.select().from(accounts).where(eq(accounts.id, THEIRS)))[0];
    expect(mine.merchantIndustry).toBe("B2B SaaS");
    expect(mine.primaryCustomerType).toBe("small businesses");
    // Dollars in, cents stored, which is the column the rest of the app reads.
    expect(mine.merchantMrrSelfReported).toBe(1_250_000);
    expect(theirs.merchantIndustry).toBe(`industry of ${THEIRS}`);
    expect(theirs.merchantMrrSelfReported).toBe(500_000);
  });

  it("create_alert writes one row on MINE and THEIRS still has exactly its own", async () => {
    const { db, tokens } = await seed();
    const { json } = await callTool(tokens[MINE], "create_alert", {
      metric: "mrr_churn_cents",
      direction: "above",
      threshold: 750,
      label: "Churn watch",
    });
    expect(resultOf(json).isError).toBeUndefined();

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
    await callTool(tokens[MINE], "create_alert", {
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

  it("SET THEN GET: an alert created through the tool comes back from get_alerts", async () => {
    const { tokens } = await seed();
    await callTool(tokens[MINE], "create_alert", {
      metric: "mrr_at_risk_cents",
      direction: "above",
      threshold: 1_000,
      label: "Risk watch",
    });
    const { json } = await callTool(tokens[MINE], "get_alerts");
    const view = resultOf(json).structuredContent as { alerts: { label: string | null }[] };
    expect(view.alerts.map((a) => a.label)).toContain("Risk watch");
  });

  it("set_alert_config disables MINE's alert and leaves THEIRS enabled", async () => {
    const { db, tokens } = await seed();
    await callTool(tokens[MINE], "set_alert_config", { alert_id: `al_${MINE}`, enabled: false });
    const mine = (await db.select().from(alerts).where(eq(alerts.id, `al_${MINE}`)))[0];
    const theirs = (await db.select().from(alerts).where(eq(alerts.id, `al_${THEIRS}`)))[0];
    expect(mine.enabled).toBe(false);
    expect(theirs.enabled).toBe(true);
  });

  it("deleting takes the alert's own firing history and NOTHING of the other account's", async () => {
    const { db, tokens } = await seed();
    await callTool(tokens[MINE], "set_alert_config", { alert_id: `al_${MINE}`, deleted: true });
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
  it("set_brand_voice REFUSES a connection belonging to the other account", async () => {
    // THE STACKED-GUARD FIXTURE: a REAL, EXISTING connection id owned by
    // somebody else. A nonexistent id would be refused by any check at all,
    // including one that only asked whether the row existed, so only an
    // ownership check can produce this refusal.
    const { db, tokens } = await seed();
    const { json } = await callTool(tokens[MINE], "set_brand_voice", {
      connection_id: `sc_${THEIRS}`,
      general: "HIJACKED",
    });
    expect(resultOf(json).isError).toBe(true);

    const theirs = await connectionOf(db, THEIRS);
    expect(theirs.brandVoice).toBe(`general of ${THEIRS}`);
    // And no trace row, because a refused write leaves neither half.
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("set_alert_config REFUSES the other account's alert, for both verbs", async () => {
    const { db, tokens } = await seed();
    const toggled = await callTool(tokens[MINE], "set_alert_config", {
      alert_id: `al_${THEIRS}`,
      enabled: false,
    });
    expect(resultOf(toggled.json).isError).toBe(true);
    const deleted = await callTool(tokens[MINE], "set_alert_config", {
      alert_id: `al_${THEIRS}`,
      deleted: true,
    });
    expect(resultOf(deleted.json).isError).toBe(true);

    const theirs = (await db.select().from(alerts).where(eq(alerts.id, `al_${THEIRS}`)))[0];
    expect(theirs.enabled).toBe(true);
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

describe("PLANT 4: omitting a field leaves it alone, clearing it clears it", () => {
  it("set_brand_voice with only the general voice does not wipe the four categories", async () => {
    const { db, tokens } = await seed();
    await callTool(tokens[MINE], "set_brand_voice", {
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
    await callTool(tokens[MINE], "set_brand_voice", {
      connection_id: `sc_${MINE}`,
      soft: "",
    });
    const mine = await connectionOf(db, MINE);
    expect(mine.brandVoiceSoft).toBeNull();
    expect(mine.brandVoice).toBe(`general of ${MINE}`);
    expect(mine.brandVoiceExpired).toBe(`expired of ${MINE}`);
  });

  it("set_intelligence_context follows the same rule on its three fields", async () => {
    const { db, tokens } = await seed();
    await callTool(tokens[MINE], "set_intelligence_context", { merchant_industry: "Fintech" });
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(mine.merchantIndustry).toBe("Fintech");
    expect(mine.primaryCustomerType).toBe(`customers of ${MINE}`);
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
    const { json } = await callTool(tokens[MINE], "create_alert", {
      metric: "recovery_rate_pct",
      direction: "above",
      threshold: 10,
    });
    const result = resultOf(json);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Choose a metric Foxhound tracks.");
  });

  it("a negative threshold is refused, in the form's words", async () => {
    const { tokens } = await seed();
    const { json } = await callTool(tokens[MINE], "create_alert", {
      metric: "health_score_avg",
      direction: "below",
      threshold: -1,
    });
    expect(JSON.stringify(resultOf(json))).toContain("Enter a threshold of zero or more.");
  });

  it("an amount that is not a number is refused rather than silently stored as null", async () => {
    // THE DEFECT THIS SESSION FOUND ON A HUMAN SURFACE. The MRR field is a
    // plain text input, so a person could always type into it and be told it
    // saved while parseDollarsToCents turned it into a null that overwrote
    // their figure. Asserted against the shipped constant so the sentence an
    // agent reads is the sentence the form shows.
    const { db, tokens } = await seed();
    const { json } = await callTool(tokens[MINE], "set_intelligence_context", {
      merchant_mrr_self_reported: "about a million",
    });
    expect(JSON.stringify(resultOf(json))).toContain(MRR_ERROR);
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

  it("STRUCTURAL: every one of the four routes calls its applyX and writes nothing itself", () => {
    // 374 binding 1: parity is not a comparison between two implementations,
    // it is the absence of a second one. This asserts the shape.
    const routes: Record<string, string[]> = {
      "app/routes/app/settings/brand-voice.tsx": ["applyBrandVoice("],
      "app/routes/app/settings/account.tsx": ["applyIntelligenceContext("],
      "app/routes/app/settings/alerts.tsx": ["applyAlertCreate(", "applyAlertConfig("],
      "app/routes/app/settings/email.tsx": ["applySenderName("],
    };
    for (const [path, calls] of Object.entries(routes)) {
      const source = code(read(path));
      for (const call of calls) expect(source, `${path} calls ${call}`).toContain(call);
      for (const writer of ["db.update(", "db.insert(", "db.delete("]) {
        expect(source, `${path} writes directly`).not.toContain(writer);
      }
    }
  });

  it("STRUCTURAL: and NO ROUTE VALIDATES DIRECTLY, which is the arm that catches drift", () => {
    // A route that kept calling the writer would fail the plant above. A route
    // that re-grew its OWN copy of the bounds while still calling applyX would
    // not, and that is the drift 372 asked to prevent. Every validator and
    // every writer these four actions used to reach for is named here.
    const forbidden: Record<string, RegExp[]> = {
      "app/routes/app/settings/brand-voice.tsx": [
        /buildBrandVoiceUpdate\s*\(/,
        /buildCategoryVoicesUpdate\s*\(/,
      ],
      "app/routes/app/settings/account.tsx": [
        /buildIntelligenceContextUpdate\s*\(/,
        /parseDollarsToCents\s*\(/,
      ],
      "app/routes/app/settings/alerts.tsx": [
        /isAlertMetric\s*\(/,
        /isAlertDirection\s*\(/,
        /isCentsMetric\s*\(/,
        /buildAlertInsert\s*\(/,
        /buildAlertEnabledUpdate\s*\(/,
        /buildAlertDelete\s*\(/,
        /buildAlertHistoryDelete\s*\(/,
      ],
    };
    for (const [path, patterns] of Object.entries(forbidden)) {
      const source = code(read(path));
      for (const pattern of patterns) {
        expect(pattern.test(source), `${path} still calls ${pattern.source}`).toBe(false);
      }
    }
  });

  it("STRUCTURAL: the untouched branches are still in their routes and reach no tool", () => {
    const account = code(read("app/routes/app/settings/account.tsx"));
    // The profile name and the danger zone stayed behind, whole.
    expect(account).toContain("buildAccountProfileUpdate(");
    expect(account).toContain("cancelMerchant(");
    // And neither is reachable from the apply layer or the tools.
    const apply = code(read("app/lib/settings/apply.server.ts"));
    const tools = code(read("app/lib/mcp/tools.server.ts"));
    for (const forbidden of ["buildAccountProfileUpdate", "cancelMerchant", "sendTestEmail"]) {
      expect(apply, `${forbidden} reached the apply layer`).not.toContain(forbidden);
      expect(tools, `${forbidden} reached the tools`).not.toContain(forbidden);
    }
  });
});

describe("PLANT 6: every write leaves a trace, naming fields and never values", () => {
  it("each of the four new tools writes one row carrying the key id and the tool", async () => {
    const { db, tokens } = await seed();
    await callTool(tokens[MINE], "set_brand_voice", {
      connection_id: `sc_${MINE}`,
      general: "Warm",
    });
    await callTool(tokens[MINE], "set_intelligence_context", { merchant_industry: "Fintech" });
    await callTool(tokens[MINE], "create_alert", {
      metric: "health_score_avg",
      direction: "below",
      threshold: 30,
    });
    await callTool(tokens[MINE], "set_alert_config", { alert_id: `al_${MINE}`, enabled: false });

    const rows = await db.select().from(mcpWrites).where(eq(mcpWrites.accountId, MINE));
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.tool).sort()).toEqual([
      "create_alert",
      "set_alert_config",
      "set_brand_voice",
      "set_intelligence_context",
    ]);
    for (const row of rows) expect(row.apiKeyId).toBe(`key_${MINE}`);

    // FIELD NAMES, and only the columns the caller actually supplied.
    const byTool = Object.fromEntries(rows.map((r) => [r.tool, r.fields as string[]]));
    expect(byTool.set_brand_voice).toEqual(["brand_voice"]);
    expect(byTool.set_intelligence_context).toEqual(["merchant_industry"]);
    expect(byTool.set_alert_config).toEqual(["enabled"]);
    expect(byTool.create_alert).toEqual(["metric", "direction", "threshold_value", "label"]);
  });

  it("NEVER VALUES: a distinctive voice does not appear anywhere in the trace", async () => {
    const { db, tokens } = await seed();
    const secret = "zqxjkv-distinctive-voice-string";
    await callTool(tokens[MINE], "set_brand_voice", {
      connection_id: `sc_${MINE}`,
      general: secret,
    });
    // It landed in the column.
    expect((await connectionOf(db, MINE)).brandVoice).toBe(secret);
    // And nowhere in the trace, which has different readers and different
    // retention from the settings table.
    const rows = await db.select().from(mcpWrites);
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
    await callTool(tokens[THEIRS], "create_alert", {
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
  it("no response from the four carries a customer id, an email or a name field", async () => {
    // The redaction rule 370 set for the read tools is not something a write
    // tool can breach by accident, because none of them reads a customer. This
    // asserts that over the RESPONSE BYTES rather than assuming it: a state
    // echo that grew a joined row would show up here.
    const { tokens } = await seed();
    const responses = [
      await callTool(tokens[MINE], "set_brand_voice", {
        connection_id: `sc_${MINE}`,
        general: "Warm",
      }),
      await callTool(tokens[MINE], "set_intelligence_context", { merchant_industry: "Fintech" }),
      await callTool(tokens[MINE], "create_alert", {
        metric: "health_score_avg",
        direction: "below",
        threshold: 30,
      }),
      await callTool(tokens[MINE], "set_alert_config", { alert_id: `al_${MINE}`, enabled: false }),
    ];
    for (const { text } of responses) {
      for (const leak of ["stripeCustomerId", "customerEmail", "customerName", "@"]) {
        expect(text, `${leak} in a write response`).not.toContain(leak);
      }
      // Nor the access token that sits on the same connection row.
      expect(text).not.toContain("stripeAccessToken");
      expect(text).not.toContain("enc");
    }
  });

  it("set_brand_voice echoes the state it wrote, so an agent can confirm without a read tool", async () => {
    const { tokens } = await seed();
    const { json } = await callTool(tokens[MINE], "set_brand_voice", {
      connection_id: `sc_${MINE}`,
      general: "Warm",
    });
    const state = resultOf(json).structuredContent as {
      updated: string[];
      state: Record<string, unknown>;
    };
    expect(state.updated).toEqual(["brand_voice"]);
    // The whole voice, including the four it left alone, which is the only way
    // an agent can see what it did not change.
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

    const { status, text } = await callTool(token, "set_brand_voice", {
      connection_id: "sc_demo",
      general: "Whatever",
    });
    expect(status).toBe(401);
    expect(text).toBe(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Unauthorized"}}',
    );
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("and the four forms still carry the demo guard the tool bypasses nothing of", () => {
    for (const path of [
      "app/routes/app/settings/brand-voice.tsx",
      "app/routes/app/settings/account.tsx",
      "app/routes/app/settings/alerts.tsx",
      "app/routes/app/settings/email.tsx",
    ]) {
      expect(code(read(path)), `${path} demo guard`).toContain("DemoGuardedForm");
    }
  });
});

describe("PLANT 9: the alert delete is two statements in the order the key requires", () => {
  it("history first, then the alert, in one batch", () => {
    const apply = code(read("app/lib/settings/apply.server.ts"));
    const historyAt = apply.indexOf("buildAlertHistoryDelete(db, accountId, alertId)");
    const alertAt = apply.indexOf("buildAlertDelete(db, accountId, alertId)");
    expect(historyAt).toBeGreaterThan(-1);
    expect(alertAt).toBeGreaterThan(-1);
    expect(historyAt).toBeLessThan(alertAt);
  });

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
