import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, mcpWrites, stripeConnections } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { SENDER_NAME_MAX_LENGTH } from "~/lib/settings/sender-name";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, toolOutput } from "./helpers/mcp-client";

// SESSION 79: THE FIRST FOUR WRITE TOOLS (372's item-4 ruling).
//
// FOUR OF EIGHT, ratified by Dustin on the sizing. These are the settings whose
// form actions were single-concern and cleanly extractable; brand voice, email
// settings, alerts and intelligence context sit inside multi-branch actions and
// are their own session.
//
// THE PROPERTY THAT MAKES A WRITE TOOL SAFE, and every plant below serves one:
//
//   1. IT WRITES THE CALLER'S ACCOUNT AND ONLY IT.
//   2. IT REFUSES WHAT THE FORM REFUSES, in the form's own words. Proven over
//      the SHARED function rather than by comparing two implementations, because
//      there is only one: `applyX` is what both callers invoke.
//   3. EVERY WRITE LEAVES A TRACE naming the key, in the same batch as the write.
//   4. THE MONEY TOOLS STILL DO NOT EXIST.
//
// THE 2026-10-10 REGROUP (job_874dc20ea9ac) folded the four tools into SECTIONS
// of one tool, foxhound_update_settings: `audit`, `features`, `notifications`
// and `sender_name`. Every property above is unchanged and is now proven through
// that tool; the trace names it rather than the old per-setting tool. The regroup
// added one property of its own, plant 6: exactly one section per call.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");
const { MERCHANT_TOOLS } = await import(
  "~/lib/mcp/tools.server"
);

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

const MINE = "acct_mine";
const THEIRS = "acct_theirs";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const UPDATE = "foxhound_update_settings";
const SECTIONS = ["audit", "features", "notifications", "sender_name", "brand_voice", "intelligence_context"];

function env(): Env {
  return {
    DB: {},
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ hit: async () => ({ ok: true, retryAfterSeconds: 60 }) }),
    },
  } as unknown as Env;
}

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
    });
  }
  return { db, tokens };
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const answer = await readMcp(
    (await handleMcpRequest(
      mcpRequest({ token, method: "tools/call", params: { name, arguments: args } }),
      env(),
      MERCHANT_TOOLS,
    )) as Response,
  );
  return { status: answer.status, text: answer.text, ...toolOutput(answer) };
}

/** One section of foxhound_update_settings, which is how each of the old four
 *  write tools is now called. */
const updateSettings = (token: string, section: string, fields: Record<string, unknown>) =>
  callTool(token, UPDATE, { [section]: fields });

const errorOf = (data: Record<string, unknown>) => (data as { error: string }).error;

describe("PLANT 2: a write lands on the caller's account and nowhere else", () => {

  it("SET THEN GET: the read tool reflects the write, end to end", async () => {
    const { tokens } = await seed();
    await updateSettings(tokens[MINE], "audit", { lookback_days: 180, auto_run: true });
    const { data } = await callTool(tokens[MINE], "foxhound_get_settings");
    expect(data.audit).toEqual({ lookbackDays: 180, autoRun: true });
  });
});

describe("PLANT 3: validator parity, over the shared function", () => {
  it("THE TOOL AND THE FORM CANNOT DISAGREE, because there is one implementation", () => {
    // DERIVED, not compared. The property is structural: each route action calls
    // the same `applyX` the tool calls, so a "same bounds" assertion is really an
    // assertion that neither side validates on its own.
    const strip = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");

    for (const [route, fn] of [
      ["app/routes/app/settings/audit.tsx", "applyAuditSettings"],
      ["app/routes/app/settings/features.tsx", "applyFeatureSettings"],
      ["app/routes/app/settings/notifications.tsx", "applyNotificationSettings"],
      ["app/routes/app/settings/email.tsx", "applySenderName"],
    ] as const) {
      const body = strip(read(route));
      expect(body, `${route} does not call ${fn}`).toContain(`${fn}(`);
      // And it no longer reaches the writer directly, which is what would let a
      // second validation path grow back.
      expect(body, `${route} still writes directly`).not.toMatch(
        /build(Feature|Notification|Sender)SettingsUpdate\(/,
      );
      // NOR DOES IT CALL A VALIDATOR ITSELF. This arm was missing on the first
      // cut and a mutation walked through it: a route can keep calling `applyX`
      // AND grow its own `normalizeSlackWebhookUrl` beside it, which is exactly
      // the two-implementations state the extraction existed to prevent. The
      // CALL is forbidden, not the import, because a route may legitimately
      // import a bound or an option list to render with.
      expect(body, `${route} validates on its own`).not.toMatch(
        /normalize(SlackWebhookUrl|Lookback)\s*\(/,
      );
    }
    const tools = strip(read("app/lib/mcp/tools.server.ts"));
    expect(tools).toContain('from "~/lib/settings/apply.server"');
  });

  it("an over-long sender name is refused with the form's own sentence and bound", async () => {
    const { tokens } = await seed();
    const { isError, data } = await updateSettings(tokens[MINE], "sender_name", {
      connection_id: `sc_${MINE}`,
      sender_name: "x".repeat(SENDER_NAME_MAX_LENGTH + 1),
    });
    expect(isError).toBe(true);
    expect(errorOf(data)).toBe(
      `Sender name must be ${SENDER_NAME_MAX_LENGTH} characters or fewer.`,
    );
    // Exactly at the bound is accepted, so the refusal is the bound and not a
    // blanket rejection of long strings.
    const ok = await updateSettings(tokens[MINE], "sender_name", {
      connection_id: `sc_${MINE}`,
      sender_name: "x".repeat(SENDER_NAME_MAX_LENGTH),
    });
    expect(ok.isError).toBe(false);
  });
});

describe("PLANT 4: every write leaves a trace naming the key", () => {
  it("a row per write, carrying the key id, the tool and the fields", async () => {
    const { db, tokens } = await seed();
    await updateSettings(tokens[MINE], "audit", { lookback_days: 30, auto_run: true });

    const rows = await db.select().from(mcpWrites);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(MINE);
    expect(rows[0].apiKeyId).toBe(`key_${MINE}`);
    // The tool the agent called, which after the regroup is the settings
    // writer; the fields say which section it touched.
    expect(rows[0].tool).toBe(UPDATE);
    expect(rows[0].fields).toEqual(["audit_lookback_days", "audit_auto_run"]);
  });

  it("THE TRACE RECORDS FIELD NAMES AND NEVER VALUES", async () => {
    // A trace carrying the new sender name would be a second copy of merchant
    // content in a log with different retention and different readers.
    const { db, tokens } = await seed();
    await updateSettings(tokens[MINE], "sender_name", {
      connection_id: `sc_${MINE}`,
      sender_name: "Zebulon Quicksilver Billing",
    });
    const rows = await db.select().from(mcpWrites);
    expect(JSON.stringify(rows)).not.toContain("Zebulon");
    expect(rows[0].fields).toEqual(["sender_name"]);
  });

  it("and the trace goes in the SAME batch, so a write cannot outrun it", () => {
    // Structural: `commit` builds one array and hands it to db.batch. A write
    // that committed before its trace would be a state the database could reach
    // with a change nobody can attribute.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
    const apply = strip(read("app/lib/settings/apply.server.ts"));
    expect(apply).toContain("batch(statements)");
    // Session 80 widened `commit` to take an ARRAY of writes, because brand
    // voice lands two statements. The literal this used to pin changed shape;
    // the property did not, so it is pinned by shape instead: the trace is the
    // last element of the one array that goes to batch, and there is exactly
    // one place that array is built.
    expect(apply).toContain("[...writes, traceInsert(db, accountId, fields, trace)]");
    expect(apply.match(/traceInsert\(db, accountId, fields, trace\)/g)).toHaveLength(1);
    // And no applyX may reach db.batch on its own, which would be a second,
    // unaudited way to write a setting.
    expect(apply.match(/\.batch\(/g)).toHaveLength(1);
  });
});

describe("PLANT 5: the write tools carry no PII and no money path", () => {
  it("a write response echoes only the new state, which has no customer data", async () => {
    const { tokens } = await seed();
    const { text } = await updateSettings(tokens[MINE], "notifications", {
      notification_email: "owner@merchant.test",
      recovery_notifications_enabled: true,
    });
    // The merchant's OWN notification address is theirs and comes back; what
    // must never appear is a customer's. No write tool reads customer_context or
    // failed_payments, so there is nothing to redact, and this asserts that
    // rather than assuming it.
    expect(text).toContain("owner@merchant.test");
    const apply = read("app/lib/settings/apply.server.ts");
    expect(apply).not.toContain("customerContext");
    expect(apply).not.toContain("failedPayments");
  });

  it("no money path reached the apply layer", () => {
    const apply = read("app/lib/settings/apply.server.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const forbidden of [
      "executeMoneyWrite",
      "recordOutcome",
      "billingLineItems",
      "recoveredPayments",
      "createPlatformInvoice",
    ]) {
      expect(apply, `${forbidden} reached the apply layer`).not.toContain(forbidden);
    }
  });
});

describe("PLANT 6: exactly one section per call", () => {
  // THE PROPERTY THE REGROUP ADDED. Each section is one form's batch, so a call
  // naming two would be two commits, and a refusal in the second would leave
  // the first applied with no way for the agent to tell from one answer. The
  // refusal comes BEFORE either section runs, so the two-section call below
  // sends two individually valid sections and proves neither landed.
  const sentence = (sent: string) =>
    `Send exactly one of ${SECTIONS.join(", ")}; this call sent ${sent}. Make one call per group.`;

  it("a call naming ZERO sections is refused with a sentence naming the sections", async () => {
    const { db, tokens } = await seed();
    const { isError, data } = await callTool(tokens[MINE], UPDATE, {});
    expect(isError).toBe(true);
    expect(errorOf(data)).toBe(sentence("none"));
    expect(data.tool).toBe(UPDATE);
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("a call naming TWO sections is refused, names both, and changes nothing", async () => {
    const { db, tokens } = await seed();
    const { isError, data } = await callTool(tokens[MINE], UPDATE, {
      audit: { lookback_days: 30, auto_run: true },
      notifications: { notification_email: "owner@merchant.test", digest_enabled: true },
    });
    expect(isError).toBe(true);
    expect(errorOf(data)).toBe(sentence("audit and notifications"));

    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(mine.auditLookbackDays).toBe(90);
    expect(mine.auditAutoRun).toBe(false);
    expect(mine.notificationEmail ?? null).toBeNull();
    expect(await db.select().from(mcpWrites)).toHaveLength(0);
  });

  it("and EACH of those sections alone is accepted, so the refusal is the count", async () => {
    const { db, tokens } = await seed();
    expect((await updateSettings(tokens[MINE], "audit", { lookback_days: 30, auto_run: true })).isError).toBe(
      false,
    );
    expect(
      (
        await updateSettings(tokens[MINE], "notifications", {
          notification_email: "owner@merchant.test",
          digest_enabled: true,
        })
      ).isError,
    ).toBe(false);
    const mine = (await db.select().from(accounts).where(eq(accounts.id, MINE)))[0];
    expect(mine.auditLookbackDays).toBe(30);
    expect(mine.notificationEmail).toBe("owner@merchant.test");
    expect(await db.select().from(mcpWrites)).toHaveLength(2);
  });
});
