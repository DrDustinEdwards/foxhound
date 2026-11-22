import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, alertHistory, alerts, apiKeys, mcpWrites, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { SENDER_NAME_MAX_LENGTH } from "~/lib/settings/sender-name";

import {
  mcpRequest,
  readMcp,
  toolCallLogStub,
  confirmedCall,
  TEST_LINK_KEY,
} from "./helpers/mcp-client";
import { createInMemoryDb } from "./helpers/inmemory-db";

// The settings and alert writers, folded into two tools: foxhound_update_settings (one section per
// call) and foxhound_manage_alerts (create, enable, disable, delete). Each section and verb calls
// the same applyX function the settings form calls. What must hold:
//   - a write lands on the caller's account and never another's;
//   - an omitted field is left alone (entered once and forgotten, so a clear would be silent);
//   - a wrong shape or a zero-row write is a refusal and writes nothing;
//   - every write leaves a trace naming the key and the fields, never the values;
//   - a destructive call is confirmed first, by a code tied to that exact call;
//   - no money path is reachable from here.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { sha256Hex } = await import("@dustinedwards/site-runtime/encoding");
const { MERCHANT_TOOLS, MERCHANT_WRITE_TOOL_NAMES } = await import("~/lib/mcp/tools.server");

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

const MINE = "acct_mine";
const THEIRS = "acct_theirs";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const UPDATE = "foxhound_update_settings";
const ALERTS = "foxhound_manage_alerts";

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
      keyHash: await sha256Hex(token),
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

/** One tools/call through the real handler, the SDK and the registry. */
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await confirmedCall(
    (a) =>
      handleMcpRequest(
        mcpRequest({ token, method: "tools/call", params: { name, arguments: a } }),
        env(),
        MERCHANT_TOOLS,
      ),
    args,
  );
  const answer = await readMcp(res);
  return { status: answer.status, text: answer.text, json: answer.json as never };
}

/** One foxhound_update_settings call carrying exactly one section. */
const updateSettings = (token: string, section: string, body: Record<string, unknown>) =>
  callTool(token, UPDATE, { [section]: body });

/** One foxhound_manage_alerts call. */
const manageAlerts = (token: string, args: Record<string, unknown>) =>
  callTool(token, ALERTS, args);

const resultOf = (json: never) =>
  (
    json as unknown as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    }
  ).result;

const wasRefused = (answer: { json: never }) => resultOf(answer.json).isError === true;

const connectionOf = async (db: Awaited<ReturnType<typeof seed>>["db"], account: string) =>
  (
    await db
      .select()
      .from(stripeConnections)
      .where(eq(stripeConnections.id, `sc_${account}`))
  )[0];

describe("the write surface", () => {
  it("is exactly the two tools, and reaches no money path", () => {
    expect(MERCHANT_WRITE_TOOL_NAMES).toEqual([UPDATE, ALERTS]);
    // The apply layer and the tool module hold no money, outcome, dispute-submission or key writer,
    // and the tool module imports no writer but the settings apply module.
    const strip = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
    const apply = strip(read("app/lib/settings/apply.server.ts"));
    for (const forbidden of [
      "executeMoneyWrite",
      "recordOutcome",
      "billingLineItems",
      "recoveredPayments",
      "createPlatformInvoice",
    ]) {
      expect(apply, `${forbidden} reached the apply layer`).not.toContain(forbidden);
    }
    const tools = strip(read("app/lib/mcp/tools.server.ts"));
    for (const forbidden of [
      "executeMoneyWrite",
      "recordOutcome",
      "saveAuditRun",
      "buildAlertInsert",
      "buildAlertEnabledUpdate",
      "buildAlertDelete",
      "createAccountApiKey",
      "revokeAccountApiKey",
      "submitDisputeEvidence",
      "deauthorize",
      "db.insert",
      "db.update",
      "db.delete",
      "db.batch",
    ]) {
      expect(tools, `${forbidden} reached the tools`).not.toContain(forbidden);
    }
    const imports = [...tools.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const path of imports) {
      expect(path, `${path} is not a read or the settings apply module`).toMatch(
        /(queries\.server|views\.server|directory\.server|trends\.server|persist\.server|preview\.server|audit-settings\.server|stats\.server|recommendations\.server|disputes\/approval|recovery\/expiring-card|recovery\/voice-samples|\.\/redact|\/render|settings\/apply\.server|\.\/confirm\.server|\.\/registry|site-runtime\/encoding)$/,
      );
    }
    // persist.server holds a writer too (saveAuditRun); only its two readers are taken from it.
    expect(tools).toMatch(
      /import \{ getAuditRun, listAuditRuns \} from "~\/lib\/audit\/persist\.server"/,
    );
  });
});

describe("a write lands on the caller's account and nowhere else", () => {
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

  it("brand_voice samples are stored on MINE, trimmed and capped, and the answer carries counts, never the text", async () => {
    const { db, tokens } = await seed();
    const { status, json, text } = await updateSettings(tokens[MINE], "brand_voice", {
      connection_id: `sc_${MINE}`,
      samples: ["  Hi Jordan, quick note about your card.  ", "", "x".repeat(3_500)],
    });
    expect(status).toBe(200);
    expect(resultOf(json).isError).toBeUndefined();
    // Two samples survive (the empty box is dropped), the long one cut to 3,000.
    expect(JSON.parse((await connectionOf(db, MINE)).brandVoiceSamples as string)).toEqual([
      "Hi Jordan, quick note about your card.",
      "x".repeat(3_000),
    ]);
    const state = resultOf(json).structuredContent.state as Record<string, unknown>;
    expect(state.sample_count).toBe(2);
    expect(state.sample_characters).toEqual([38, 3_000]);
    expect("samples" in state).toBe(false);
    expect(text).not.toContain("Jordan");
    // Nothing of THEIRS moved, and an empty list clears MINE.
    expect((await connectionOf(db, THEIRS)).brandVoiceSamples).toBeNull();
    await updateSettings(tokens[MINE], "brand_voice", { connection_id: `sc_${MINE}`, samples: [] });
    expect((await connectionOf(db, MINE)).brandVoiceSamples).toBeNull();
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

  it("action disable turns MINE's alert off and leaves THEIRS enabled; enable turns it back on", async () => {
    const { db, tokens } = await seed();
    const enabledOf = async (account: string) =>
      (
        await db
          .select()
          .from(alerts)
          .where(eq(alerts.id, `al_${account}`))
      )[0].enabled;

    const off = await manageAlerts(tokens[MINE], { action: "disable", alert_id: `al_${MINE}` });
    expect(resultOf(off.json).isError).toBeUndefined();
    expect(await enabledOf(MINE)).toBe(false);
    expect(await enabledOf(THEIRS)).toBe(true);

    const on = await manageAlerts(tokens[MINE], { action: "enable", alert_id: `al_${MINE}` });
    expect(resultOf(on.json).isError).toBeUndefined();
    expect(resultOf(on.json).structuredContent.state).toEqual({
      id: `al_${MINE}`,
      enabled: true,
      deleted: false,
    });
    expect(await enabledOf(MINE)).toBe(true);
  });
});

describe("exactly one section per call", () => {
  // Each section is one form's batch, so a call naming two would be two commits and a refusal in
  // the second would leave the first applied. The refusal comes before either section runs.
  it("zero or two sections are refused and change nothing; one section alone is accepted", async () => {
    const { db, tokens } = await seed();
    const none = await callTool(tokens[MINE], UPDATE, {});
    expect(wasRefused(none)).toBe(true);

    const two = await callTool(tokens[MINE], UPDATE, {
      audit: { lookback_days: 30, auto_run: true },
      notifications: { notification_email: "owner@merchant.test", digest_enabled: true },
    });
    expect(wasRefused(two)).toBe(true);
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
    const refused = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(refused.auditLookbackDays).toBe(90);
    expect(refused.notificationEmail ?? null).toBeNull();

    const one = await updateSettings(tokens[MINE], "audit", { lookback_days: 30, auto_run: true });
    expect(wasRefused(one)).toBe(false);
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(mine.auditLookbackDays).toBe(30);
  });
});

describe("a wrong shape writes nothing", () => {
  it("an over-long sender name is refused at the form's bound, and the bound itself is accepted", async () => {
    const { tokens } = await seed();
    const over = await updateSettings(tokens[MINE], "sender_name", {
      connection_id: `sc_${MINE}`,
      sender_name: "x".repeat(SENDER_NAME_MAX_LENGTH + 1),
    });
    expect(wasRefused(over)).toBe(true);
    const ok = await updateSettings(tokens[MINE], "sender_name", {
      connection_id: `sc_${MINE}`,
      sender_name: "x".repeat(SENDER_NAME_MAX_LENGTH),
    });
    expect(wasRefused(ok)).toBe(false);
  });

  it("an unknown action, or enable, disable and delete without alert_id, are refused", async () => {
    const { db, tokens } = await seed();
    for (const args of [
      { action: "pause", alert_id: `al_${MINE}` },
      { action: "enable" },
      { action: "disable" },
      { action: "delete" },
    ]) {
      const result = resultOf((await manageAlerts(tokens[MINE], args)).json);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    for (const account of [MINE, THEIRS]) {
      const row = (
        await db
          .select()
          .from(alerts)
          .where(eq(alerts.id, `al_${account}`))
      )[0];
      expect(row.enabled).toBe(true);
    }
    expect(await db.select().from(alertHistory)).toHaveLength(2);
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("create with an alert_id is refused, so a misread verb cannot create a duplicate", async () => {
    const { db, tokens } = await seed();
    const { json } = await manageAlerts(tokens[MINE], {
      action: "create",
      alert_id: `al_${MINE}`,
      metric: "high_risk_customers_count",
      direction: "below",
      threshold: 30,
    });
    expect(resultOf(json).isError).toBe(true);
    expect(await db.select().from(alerts).where(eq(alerts.accountId, MINE))).toHaveLength(1);
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("an omitted field is left alone, and an empty string clears only its own field", async () => {
    const { db, tokens } = await seed();
    await updateSettings(tokens[MINE], "intelligence_context", { primary_customer_type: "" });
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(mine.primaryCustomerType).toBeNull();
    expect(mine.merchantIndustry).toBe(`industry of ${MINE}`);
    expect(mine.merchantMrrSelfReported).toBe(500_000);
  });
});

describe("every write leaves a trace, naming fields and never values", () => {
  it("each write leaves one row carrying the key id, the tool and the fields it sent", async () => {
    const { db, tokens } = await seed();
    // Each call's row is read as the one row it added, so the fields are pinned to the call that
    // wrote them rather than matched up afterwards.
    const traceOf = async (call: () => Promise<unknown>) => {
      const before = new Set((await db.select().from(mcpWrites)).map((r) => r.id));
      await call();
      const added = (await db.select().from(mcpWrites)).filter((r) => !before.has(r.id));
      expect(added).toHaveLength(1);
      return added[0];
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
    const sender = await traceOf(() =>
      updateSettings(tokens[MINE], "sender_name", {
        connection_id: `sc_${MINE}`,
        sender_name: "Zebulon Quicksilver Billing",
      }),
    );

    // The trace names the tool that ran, which is the folded tool, not the section or the verb.
    expect([voice, context, created, disabled, sender].map((r) => r.tool)).toEqual([
      UPDATE,
      UPDATE,
      ALERTS,
      ALERTS,
      UPDATE,
    ]);
    for (const row of [voice, context, created, disabled, sender]) {
      expect(row.apiKeyId).toBe(`key_${MINE}`);
      expect(row.accountId).toBe(MINE);
    }
    // Field names, and only the columns the caller actually supplied.
    expect(voice.fields).toEqual(["brand_voice"]);
    expect(context.fields).toEqual(["merchant_industry"]);
    expect(created.fields).toEqual(["metric", "direction", "threshold_value", "label", "channel"]);
    expect(disabled.fields).toEqual(["enabled"]);
    // A trace carrying a value would be a second copy of merchant content in another log.
    expect(JSON.stringify(await db.select().from(mcpWrites))).not.toMatch(/Zebulon|Fintech|Warm/);
  });
});

describe("a destructive call is confirmed first, by a code tied to that exact call", () => {
  it("the first call deletes nothing, another call's code is refused, and the matching code deletes", async () => {
    const { db, tokens } = await seed();
    const send = async (args: Record<string, unknown>) =>
      resultOf(
        (
          await readMcp(
            (await handleMcpRequest(
              mcpRequest({
                token: tokens[MINE],
                method: "tools/call",
                params: { name: ALERTS, arguments: args },
              }),
              env(),
              MERCHANT_TOOLS,
            )) as Response,
          )
        ).json as never,
      );
    const asked = await send({ action: "delete", alert_id: `al_${MINE}` });
    expect(asked.structuredContent).toMatchObject({ confirmation_required: true });
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
    // A code for one alert does not delete another.
    const other = await send({
      action: "delete",
      alert_id: `al_${THEIRS}`,
      confirm: asked.structuredContent.confirm,
    });
    expect(other.structuredContent).toMatchObject({ confirmation_required: true });
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
    const done = await send({
      action: "delete",
      alert_id: `al_${MINE}`,
      confirm: asked.structuredContent.confirm,
    });
    expect(done.structuredContent).toMatchObject({ action: "delete" });
    const traced = await db.select().from(mcpWrites);
    expect(traced).toHaveLength(1);
    expect(traced[0].fields).toEqual(["deleted"]);
  });
});
