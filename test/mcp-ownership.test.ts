import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  accounts,
  alertHistory,
  alerts,
  apiKeys,
  auditRuns,
  billingInvoices,
  customerContext,
  disputes,
  failedPayments,
  stripeConnections,
} from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

import { createInMemoryDb } from "./helpers/inmemory-db";
import {
  mcpRequest,
  readMcp,
  toolOutput,
  toolCallLogStub,
  confirmedCall,
  TEST_LINK_KEY,
} from "./helpers/mcp-client";

// Every tool that takes an id proves the caller owns it: one merchant must not read or change
// another's row. The other merchant's row is real and carries a distinctive marker, so a tool that
// dropped its account predicate would return or change it. Each case proves my own id works (the
// refusal is the check, not a broken tool), theirs is refused, and their row reads back unchanged.
// The table is complete by construction: a schema walk fails on any _id argument without a case.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { sha256Hex } = await import("@dustinedwards/site-runtime/encoding");
const { MERCHANT_TOOLS } = await import("~/lib/mcp/tools.server");

const MINE = "acct_mine";
const THEIRS = "acct_theirs";
const NOW = new Date("2026-10-10T12:00:00.000Z");
/** Distinctive, so a substring search over the answer cannot match by accident. */
const THEIR_MARK = "Quillon-Marsh-7731";

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

type Db = ReturnType<typeof createInMemoryDb>["db"];

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  const tokens: Record<string, string> = {};
  for (const account of [MINE, THEIRS]) {
    const mark = account === THEIRS ? THEIR_MARK : "mine";
    await db
      .insert(accounts)
      .values({ id: account, name: account, createdAt: NOW, currency: "usd" });
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
    await db.insert(disputes).values({
      id: `dp_${account}`,
      accountId: account,
      stripeDisputeId: `dp_stripe_${account}`,
      stripeChargeId: `ch_${account}`,
      amountCents: 2_500,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      state: "draft",
      createdAt: NOW,
    });
    await db.insert(billingInvoices).values({
      id: `inv_${account}`,
      accountId: account,
      currency: "usd",
      periodStart: new Date("2026-09-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      status: "paid",
      totalCents: 1_000,
      idempotencyKey: `idem_${account}`,
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
  const res = await confirmedCall(
    (a) =>
      handleMcpRequest(
        mcpRequest({ token, method: "tools/call", params: { name, arguments: a } }),
        env(),
        MERCHANT_TOOLS,
      ),
    args,
  );
  return readMcp(res);
}

/** Their row, as a snapshot to compare before and after a refused write. */
async function theirRows(db: Db) {
  const [connection] = await db
    .select()
    .from(stripeConnections)
    .where(eq(stripeConnections.id, `sc_${THEIRS}`));
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, `al_${THEIRS}`));
  const history = await db
    .select()
    .from(alertHistory)
    .where(eq(alertHistory.alertId, `al_${THEIRS}`));
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
    tool: "foxhound_list_disputes",
    path: "dispute_id",
    args: (id) => ({ dispute_id: id }),
    idFor: (a) => `dp_${a}`,
  },
  {
    tool: "foxhound_get_billing",
    path: "invoice_id",
    args: (id) => ({ invoice_id: id }),
    idFor: (a) => `inv_${a}`,
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

describe("every id argument has an ownership case", () => {
  it("the schema walk and the case table name the same arguments", () => {
    const fromSchemas = MERCHANT_TOOLS.list()
      .flatMap((tool) => idPaths(tool.inputSchema).map((path) => `${tool.name} ${path}`))
      .sort();
    const fromCases = CASES.map((c) => `${c.tool} ${c.path}`).sort();
    expect(fromSchemas).toEqual(fromCases);
  });
});

describe("another merchant's id is refused, and their row is untouched", () => {
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

describe("the lists only ever hold my rows", () => {
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
