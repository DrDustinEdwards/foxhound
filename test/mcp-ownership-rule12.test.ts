import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  alertHistory,
  alerts,
  apiKeys,
  auditRuns,
  customerContext,
  failedPayments,
  stripeConnections,
} from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, toolOutput } from "./helpers/mcp-client";

// RULE 12.1 OF THE 2026-10-10 MCP RULING: every tool that takes an id proves
// the caller owns it, with a planted test that fails without the check.
//
// THE HOLE THIS KEEPS OUT is Recova's trigger_immediate_retry, which inserted a
// retry for whatever failed_payment_id it was handed with no ownership check,
// so one merchant could queue a charge attempt on another merchant's payment.
//
// HOW EACH PLANT DISCRIMINATES. The other merchant's row is REAL and carries a
// distinctive marker, so a tool that dropped its account predicate would find
// it and return or change it. Each case proves three things: my own id works
// (so the refusal is the check, not a broken tool), the other merchant's id is
// refused as not found, and the other merchant's row reads back unchanged.
// Removing the account predicate from any helper behind these tools turned the
// matching case red; that was run by hand for each one when this file landed.
// The two connection-id cases now have a second check in front of the writer
// (PLANT 4's clear refusal), so for those it takes removing both to go red.
//
// AND THE TABLE IS COMPLETE BY CONSTRUCTION. The first plant walks every
// tool's input schema for an argument ending in _id and fails unless each one
// has a case below, so a tool that gains an id argument next year cannot ship
// without its ownership plant.

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
const NOW = new Date("2026-10-10T12:00:00.000Z");
/** Distinctive, so a substring search over the answer cannot match by accident. */
const THEIR_MARK = "Quillon-Marsh-7731";

function env(): Env {
  return {
    DB: {},
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ check: async () => ({ allowed: true, retryAfterSec: 60 }) }),
    },
  } as unknown as Env;
}

type Db = ReturnType<typeof createInMemoryDb>["db"];

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  const tokens: Record<string, string> = {};
  for (const account of [MINE, THEIRS]) {
    const mark = account === THEIRS ? THEIR_MARK : "mine";
    await db.insert(accounts).values({ id: account, name: account, createdAt: NOW, currency: "usd" });
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
    await db.insert(failedPayments).values({
      id: `fp_${account}`,
      stripeEventId: `evt_${account}`,
      stripeInvoiceId: `in_${account}`,
      stripeCustomerId: `cus_${account}`,
      customerEmail: `${account}@example.test`,
      planName: `plan ${mark}`,
      amountCents: account === THEIRS ? 777_700 : 1_100,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: NOW,
      accountId: account,
    });
    await db.insert(customerContext).values({
      id: `cc_${account}`,
      accountId: account,
      stripeCustomerId: `cus_${account}`,
      customerEmail: `${account}@example.test`,
      currency: "usd",
      mrrContributionCents: 5_000,
      healthScore: 42,
      aiAssessment: `assessment ${mark}`,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(auditRuns).values({
      id: `ar_${account}`,
      accountId: account,
      runAt: NOW,
      lookbackDays: 90,
      aiSummary: `summary ${mark}`,
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
      senderName: `sender ${mark}`,
      brandVoice: `voice ${mark}`,
    });
    await db.insert(alerts).values({
      id: `al_${account}`,
      accountId: account,
      metric: "mrr_at_risk_cents",
      direction: "above",
      thresholdValue: 100_000,
      channel: "email",
      label: `alert ${mark}`,
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
      actualValue: 150_000,
      channel: "email",
      firedAt: NOW,
    });
  }
  return { db, tokens };
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const res = (await handleMcpRequest(
    mcpRequest({ token, method: "tools/call", params: { name, arguments: args } }),
    env(),
    MERCHANT_TOOLS,
  )) as Response;
  return readMcp(res);
}

/** Their row, as a snapshot to compare before and after a refused write. */
async function theirRows(db: Db) {
  const [connection] = await db.select().from(stripeConnections).where(eq(stripeConnections.id, `sc_${THEIRS}`));
  const [alert] = await db.select().from(alerts).where(eq(alerts.id, `al_${THEIRS}`));
  const history = await db.select().from(alertHistory).where(eq(alertHistory.alertId, `al_${THEIRS}`));
  return { connection, alert, history };
}

interface OwnershipCase {
  /** The tool and the argument path, as the schema walk names it. */
  tool: string;
  path: string;
  /** The arguments, given the id to put at `path`. */
  args: (id: string) => Record<string, unknown>;
  /** The id of the row each account owns. */
  idFor: (account: string) => string;
}

const CASES: OwnershipCase[] = [
  {
    tool: "foxhound_get_payment",
    path: "payment_id",
    args: (id) => ({ payment_id: id }),
    idFor: (a) => `fp_${a}`,
  },
  {
    tool: "foxhound_get_customer",
    path: "stripe_customer_id",
    args: (id) => ({ stripe_customer_id: id }),
    idFor: (a) => `cus_${a}`,
  },
  {
    tool: "foxhound_review_audits",
    path: "run_id",
    args: (id) => ({ run_id: id }),
    idFor: (a) => `ar_${a}`,
  },
  {
    tool: "foxhound_update_settings",
    path: "sender_name.connection_id",
    args: (id) => ({ sender_name: { connection_id: id, sender_name: "Hijacked" } }),
    idFor: (a) => `sc_${a}`,
  },
  {
    tool: "foxhound_update_settings",
    path: "brand_voice.connection_id",
    args: (id) => ({ brand_voice: { connection_id: id, general: "Hijacked" } }),
    idFor: (a) => `sc_${a}`,
  },
  {
    tool: "foxhound_manage_alerts",
    path: "alert_id",
    args: (id) => ({ action: "disable", alert_id: id }),
    idFor: (a) => `al_${a}`,
  },
];

/** Every argument path ending in _id, at any depth of a tool's input schema. */
function idPaths(schema: unknown, prefix = ""): string[] {
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.entries(properties).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = (value as { type?: unknown }).type === "object" ? idPaths(value, path) : [];
    return key.endsWith("_id") ? [path, ...nested] : nested;
  });
}

// ============================================================================

describe("PLANT 1: every id argument has an ownership case", () => {
  it("the schema walk and the case table name the same arguments", () => {
    const fromSchemas = MERCHANT_TOOLS.list()
      .flatMap((tool) => idPaths(tool.inputSchema).map((path) => `${tool.name} ${path}`))
      .sort();
    const fromCases = CASES.map((c) => `${c.tool} ${c.path}`).sort();
    expect(fromSchemas).toEqual(fromCases);
    // Not vacuous: there are id arguments to cover.
    expect(fromSchemas.length).toBeGreaterThanOrEqual(6);
  });

  it("no tool takes an account id at all: the account is the key's", () => {
    for (const tool of MERCHANT_TOOLS.list()) {
      expect(idPaths(tool.inputSchema).some((p) => p.includes("account")), tool.name).toBe(false);
    }
  });
});

describe("PLANT 2: another merchant's id is refused, and their row is untouched", () => {
  for (const c of CASES) {
    it(`${c.tool} ${c.path}`, async () => {
      const { db, tokens } = await seed();

      // My own id works, so the refusal below is the ownership check and not a
      // tool that refuses everything.
      const own = toolOutput(await callTool(tokens[MINE], c.tool, c.args(c.idFor(MINE))));
      expect(own.isError, `${c.tool} refused my own id: ${JSON.stringify(own.data)}`).toBe(false);

      const before = await theirRows(db);
      const answer = await callTool(tokens[MINE], c.tool, c.args(c.idFor(THEIRS)));
      const crossed = toolOutput(answer);

      expect(crossed.isError, `${c.tool} accepted another merchant's id`).toBe(true);
      // The refusal is a sentence (the writers reuse the form's own, so a
      // foreign id reads exactly as a missing one), and nothing of theirs
      // rides on it.
      expect(String(crossed.data.error).length).toBeGreaterThan(5);
      expect(answer.text).not.toContain(THEIR_MARK);
      expect(answer.text).not.toContain("777700");

      // And their side reads back exactly as it was.
      expect(await theirRows(db)).toEqual(before);
    });
  }
});

describe("PLANT 3: the lists only ever hold my rows", () => {
  it("no list or overview answer carries the other merchant's marker", async () => {
    const { tokens } = await seed();
    for (const tool of MERCHANT_TOOLS.list().filter((t) => t.annotations.readOnlyHint)) {
      if (idPaths(tool.inputSchema).length > 0 && tool.inputSchema.required?.length) continue;
      const answer = await callTool(tokens[MINE], tool.name, {});
      expect(toolOutput(answer).isError, tool.name).toBe(false);
      expect(answer.text, tool.name).not.toContain(THEIR_MARK);
      expect(answer.text, tool.name).not.toContain(THEIRS);
    }
  });
});

describe("PLANT 4: another merchant's connection id gets a refusal that says so", () => {
  // The writers reuse the settings form's sentence ("Connect Stripe before
  // setting a sender name."), which is right for a person with no connection
  // and wrong for an agent that sent an id it should not have. The tool checks
  // the id against this account's own connections first and says what to fix.
  for (const section of ["sender_name", "brand_voice"] as const) {
    it(`${section}: names the id, says it is not this account's, and says where ids come from`, async () => {
      const { db, tokens } = await seed();
      const before = await theirRows(db);
      const crossed = toolOutput(
        await callTool(tokens[MINE], "foxhound_update_settings", {
          [section]: { connection_id: `sc_${THEIRS}`, ...(section === "sender_name" ? { sender_name: "x" } : { general: "x" }) },
        }),
      );
      expect(crossed.isError).toBe(true);
      expect(crossed.data.error).toBe(
        `Connection sc_${THEIRS} is not one of this account's Stripe connections. Take a connection id from foxhound_get_settings.`,
      );
      expect(await theirRows(db)).toEqual(before);
    });
  }
});

