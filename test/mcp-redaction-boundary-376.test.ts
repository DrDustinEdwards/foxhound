import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, customerContext, disputes, failedPayments } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { defineToolRegistry, type McpToolContext } from "~/lib/mcp/registry";
import { REDACTED_CUSTOMER_FIELDS, redactToolResult } from "~/lib/mcp/redact";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 83: THE REDACTION IS STRUCTURAL, AND THIS IS WHAT WATCHES IT (376
// item 7).
//
// WHAT WENT WRONG, because the guard is shaped by it. 370 ruled DEFAULT-REDACT
// and session 77 implemented it as three calls to a helper, made by the three
// tools whose authors knew to make them. `list_disputes`, `get_churn` and
// `get_intelligence_overview` all returned customer rows and called nothing,
// while /docs and llms.txt promised the endpoint redacts with no per-tool
// qualification. The ruling was narrower than its own promise.
//
// SO THE PROPERTY UNDER TEST IS NOT "THE THREE TOOLS REDACT". It is:
//
//   NO REGISTERED TOOL CAN RETURN A CUSTOMER NAME OR A RAW EMAIL, INCLUDING ONE
//   NOBODY HAS WRITTEN YET.
//
// which is why PLANT 2 registers a tool that does not exist in the product: a
// guard that only knows today's tool list cannot fail on tomorrow's.
//
// AND WHY THE OLD SUITE STAYED GREEN THROUGH ALL OF IT, which is the fixture
// lesson worth keeping: session 77's fixture scored its customer at 42, and both
// `get_churn` and `get_intelligence_overview` only return customers scoring
// BELOW 40. Both tools ran in that suite's cross-account sweep and both returned
// an empty list, so the sweep passed on tools that were leaking. A fixture value
// three points too high hid a defect for six sessions. Every customer here is
// scored at 12.

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

const MINE = "acct_mine";
const THEIRS = "acct_theirs";
const NOW = new Date("2026-08-25T12:00:00.000Z");
const ORIGIN = "https://foxhoundapp.test";

/** Values that must never appear in a response. Deliberately distinctive, so a
 *  substring search over the bytes cannot match by accident. */
const MY_NAME = "Zebulon Quicksilver";
const MY_EMAIL = "zebulon.quicksilver@example.test";
const THEIR_NAME = "Persephone Nightingale";
const THEIR_EMAIL = "persephone.nightingale@other.test";

/** Below HEALTH_SCORE_AT_RISK_THRESHOLD (40), so the two aggregate views
 *  actually return a customer row. See the fixture lesson in the header. */
const AT_RISK_SCORE = 12;

/**
 * EVERY READ TOOL, WITH THE ARGUMENTS IT NEEDS TO RETURN SOMETHING.
 *
 * This map is the sweep's one hand-written thing, and PLANT 4 refuses to let it
 * drift from the registry in either direction: a read tool with no entry here is
 * a tool the sweep would silently skip, and an entry naming a tool that is not
 * registered is a line somebody left behind after a rename. Adding a read tool
 * without adding it here is a failing build, which is the point.
 */
const READ_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  list_audit_runs: {},
  get_audit_run: { run_id: "run_missing" },
  get_audit_settings: {},
  get_intelligence_overview: {},
  get_churn: {},
  list_customers: {},
  get_customer_health: { stripe_customer_id: `cus_${MINE}` },
  list_customer_tiers: {},
  get_alerts: {},
  list_failed_payments: {},
  list_disputes: {},
  get_billing: {},
  list_connections: {},
  get_brand_voice: {},
  get_intelligence_context: {},
};

/**
 * THE POSITIVE CONTROL, and it is not the guard.
 *
 * The sweep asserts an ABSENCE, and an absence passes trivially against an empty
 * list. These are the tools the fixture puts a customer row into, so each must
 * come back carrying the customer id: that is what proves the sweep had
 * something to discriminate on rather than six empty arrays. The guard itself
 * stays derived over the whole registry.
 */
const TOOLS_THAT_MUST_RETURN_A_CUSTOMER = [
  "list_customers",
  "get_customer_health",
  "list_failed_payments",
  "list_disputes",
  "get_churn",
  "get_intelligence_overview",
] as const;

function env(): Env {
  return {
    DB: {},
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ check: async () => ({ allowed: true, retryAfterSec: 60 }) }),
    },
  } as unknown as Env;
}

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  const tokens: Record<string, string> = {};
  for (const [account, name, email] of [
    [MINE, MY_NAME, MY_EMAIL],
    [THEIRS, THEIR_NAME, THEIR_EMAIL],
  ] as const) {
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
    await db.insert(customerContext).values({
      id: `cc_${account}`,
      accountId: account,
      stripeCustomerId: `cus_${account}`,
      customerName: name,
      customerEmail: email,
      currency: "usd",
      mrrContributionCents: 5000,
      healthScore: AT_RISK_SCORE,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(failedPayments).values({
      id: `fp_${account}`,
      stripeEventId: `evt_${account}`,
      stripeInvoiceId: `in_${account}`,
      stripeCustomerId: `cus_${account}`,
      customerEmail: email,
      amountCents: 9900,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: NOW,
      accountId: account,
    });
    await db.insert(disputes).values({
      id: `dp_${account}`,
      accountId: account,
      stripeDisputeId: `dp_stripe_${account}`,
      stripeChargeId: `ch_${account}`,
      stripeCustomerId: `cus_${account}`,
      customerEmail: email,
      customerName: name,
      amountCents: 4200,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      state: "draft",
      createdAt: NOW,
      // The columns the boundary redactor cannot reach, which is why the tool
      // projects instead of returning the row. Each is asserted absent below.
      customerIp: "203.0.113.77",
      billingAddress: "14 Coriander Lane, Bakersfield",
      aiResponseText: `Dear ${name}, we are contesting this dispute.`,
      triageReasoning: `${name} has three prior charges on file.`,
    });
  }
  return { db, tokens };
}

async function call(token: string, method: string, params: unknown = {}) {
  const res = (await handleMcpRequest(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env(),
    MERCHANT_TOOLS,
  )) as Response;
  const text = await res.text();
  return { status: res.status, text };
}

const callTool = (token: string, name: string, args: Record<string, unknown> = {}) =>
  call(token, "tools/call", { name, arguments: args });

/** The read half of the registry, DERIVED: everything registered, minus the
 *  writes that name themselves. Never a hand-kept list of reads. */
const READ_TOOL_NAMES = MERCHANT_TOOL_NAMES.filter(
  (name) => !MERCHANT_WRITE_TOOL_NAMES.includes(name),
);

// ============================================================================

describe("PLANT 1: no read tool returns a customer name or a raw email", () => {
  it("sweeps EVERY registered read tool over the response bytes", async () => {
    const { tokens } = await seed();
    // DERIVED OVER THE REGISTRY, not over a list of the tools known to carry
    // PII. Deciding in advance which tools carry a customer row is exactly the
    // judgement 370 got wrong, and it is the judgement this sweep refuses to
    // make: every read tool is driven, and the three that were leaking are found
    // by the same assertion that will find the fourth.
    for (const name of READ_TOOL_NAMES) {
      const { status, text } = await callTool(tokens[MINE], name, READ_TOOL_ARGS[name]);
      expect(status, `${name} did not answer`).toBe(200);
      // SOFT, so one run names EVERY leaking tool rather than stopping at the
      // first. A sweep that reports one of six leaks sends the next session to
      // fix one of six, which is how 376 item 7 came to list three tools that
      // had all been failing the same rule since session 77.
      expect.soft(text, `${name} leaked the customer name`).not.toContain(MY_NAME);
      expect.soft(text, `${name} leaked the raw email`).not.toContain(MY_EMAIL);
      // The other account's data has no business here whatever the redaction
      // does, so the two-account pin rides along.
      expect.soft(text, `${name} leaked the other account`).not.toContain(THEIR_NAME);
      expect.soft(text, `${name} leaked the other email`).not.toContain(THEIR_EMAIL);
    }
  });

  it("the sweep had something to find: the customer-carrying tools returned rows", async () => {
    const { tokens } = await seed();
    // Without this, PLANT 1 passes on six empty arrays. This is the positive
    // control for the fixture, not a second copy of the guard.
    for (const name of TOOLS_THAT_MUST_RETURN_A_CUSTOMER) {
      const { text } = await callTool(tokens[MINE], name, READ_TOOL_ARGS[name]);
      expect(text, `${name} returned nothing to redact`).toContain(`cus_${MINE}`);
    }
  });

  it("the masked form is present, so this is masking and not deletion", async () => {
    const { tokens } = await seed();
    const { text } = await callTool(tokens[MINE], "list_customers");
    expect(text).toContain("z***@example.test");
  });

  it("the dispute row is PROJECTED, so the columns the redactor cannot reach never ship", async () => {
    const { tokens } = await seed();
    const { text } = await callTool(tokens[MINE], "list_disputes");
    // Not name or email fields, so no redactor keyed on those two could ever
    // remove them. The tool returning a pick rather than the row is the only
    // thing standing between an agent and the customer's address.
    expect(text, "leaked the customer IP").not.toContain("203.0.113.77");
    expect(text, "leaked the billing address").not.toContain("Coriander Lane");
    expect(text, "leaked the model-written evidence").not.toContain("we are contesting");
    expect(text, "leaked the triage reasoning").not.toContain("three prior charges");
    // And the dispute is still usable: what it is, what it is worth, where it
    // stands, and the correlation key.
    expect(text).toContain("fraudulent");
    expect(text).toContain("4200");
    expect(text).toContain(`cus_${MINE}`);
  });
});

describe("PLANT 2: REGISTRATION is what redacts, so a tool nobody has written yet is covered", () => {
  const ctx = { accountId: MINE, now: NOW } as unknown as McpToolContext;

  it("a brand new tool that never heard of the redactor comes back redacted", async () => {
    // THE FOURTH TOOL. It does not exist in the product and never will; it
    // exists to prove the guard is not a list of the other twenty-one. It
    // returns a customer row the way a careless future tool would, straight off
    // a helper, with no redaction anywhere in it.
    const registry = defineToolRegistry([
      {
        name: "list_future_customers",
        description: "A tool written next year by somebody who never read redact.ts.",
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: async () => ({
          rows: [{ stripeCustomerId: "cus_1", customerName: MY_NAME, customerEmail: MY_EMAIL }],
        }),
      },
    ]);

    const tool = registry.get("list_future_customers");
    expect(tool).not.toBeNull();
    const out = (await tool!.execute(ctx, {})) as {
      rows: { customerName: unknown; customerEmail: unknown; stripeCustomerId: string }[];
    };
    expect(out.rows[0].customerName).toBeNull();
    expect(out.rows[0].customerEmail).toBe("z***@example.test");
    expect(out.rows[0].stripeCustomerId).toBe("cus_1");
  });

  it("AN IP AND A BILLING ADDRESS REACH THE WIRE AND ARE REDACTED (383)", async () => {
    // 383 ruled location into the set: an address is more reachable than an
    // email and an IP is where somebody was. This drives them through a
    // REGISTERED tool, because registration is the thing that applies the rule,
    // and nothing in the product returns either field any more: list_disputes
    // projects them away, so without a synthetic carrier the new half of the
    // ruling would have no executed coverage at all.
    const registry = defineToolRegistry([
      {
        name: "list_future_locations",
        description: "A tool that returns the two fields 383 added.",
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: async () => ({
          rows: [
            {
              stripeCustomerId: "cus_1",
              customerIp: "203.0.113.77",
              billingAddress: "14 Coriander Lane, Bakersfield",
              customerPhone: "+1 555 0134",
              amountCents: 4200,
            },
          ],
        }),
      },
    ]);

    const out = (await registry.get("list_future_locations")!.execute(ctx, {})) as {
      rows: Record<string, unknown>[];
    };
    expect(out.rows[0].customerIp).toBeNull();
    expect(out.rows[0].billingAddress).toBeNull();
    // Listed against a column that does not exist yet, on purpose: the day a
    // helper starts returning one it is already covered.
    expect(out.rows[0].customerPhone).toBeNull();
    // Dropped, not deleted, and the row is still useful.
    expect("customerIp" in out.rows[0]).toBe(true);
    expect(out.rows[0].amountCents).toBe(4200);
    expect(out.rows[0].stripeCustomerId).toBe("cus_1");
    // And over the bytes, which is where a missed nested case would show.
    expect(JSON.stringify(out)).not.toContain("203.0.113.77");
    expect(JSON.stringify(out)).not.toContain("Coriander Lane");
    expect(JSON.stringify(out)).not.toContain("555 0134");
  });

  it("THE CONSTANT IS WHAT ENFORCES: every listed field is redacted, derived from the constant", () => {
    // 379 binding 3 applied to this guard's own reader. The subject is DERIVED
    // from REDACTED_CUSTOMER_FIELDS rather than re-listed here, so removing a
    // field from the constant removes its protection AND is caught, and the
    // assertion cannot silently stop covering a field somebody deletes.
    const names = Object.keys(REDACTED_CUSTOMER_FIELDS);
    expect(names.length).toBeGreaterThan(0);
    // The set 383 ruled, asserted by membership so the plant that removes one is
    // red here as well as on the wire.
    expect(names.sort()).toEqual([
      "billingAddress",
      "customerEmail",
      "customerIp",
      "customerName",
      "customerPhone",
    ]);

    const row: Record<string, unknown> = { keepMe: "untouched" };
    for (const name of names) row[name] = `RAW-${name}@example.test`;
    const out = redactToolResult(row) as Record<string, unknown>;

    for (const name of names) {
      expect(out[name], `${name} came back raw`).not.toBe(row[name]);
      expect(JSON.stringify(out), `${name} leaked`).not.toContain(`RAW-${name}`);
    }
    expect(out.keepMe).toBe("untouched");
  });

  it("the wrapping is on `get`, not only on the transport", async () => {
    // `get()` hands the tool to whoever asks. A future caller that is not the
    // JSON-RPC dispatch must not be redaction-free by default, which is why the
    // wrap lives in the registry rather than in handler.server.ts.
    const registry = defineToolRegistry([
      {
        name: "get_future_customer",
        description: "Another one.",
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: async () => ({ customerName: MY_NAME }),
      },
    ]);
    const direct = (await registry.get("get_future_customer")!.execute(ctx, {})) as {
      customerName: unknown;
    };
    expect(direct.customerName).toBeNull();
  });
});

describe("PLANT 3: the walk itself", () => {
  it("redacts at depth, through arrays and nested containers", () => {
    // `get_churn` buries its rows two deep. A top-level check would have passed
    // every one of the three tools that were leaking.
    const out = redactToolResult({
      bands: [{ band: "at_risk", customerCount: 1 }],
      topHighRisk: [{ stripeCustomerId: "cus_1", customerName: MY_NAME }],
      nested: { deeper: { rows: [{ customerEmail: MY_EMAIL }] } },
    }) as {
      topHighRisk: { customerName: unknown }[];
      nested: { deeper: { rows: { customerEmail: unknown }[] } };
      bands: { customerCount: number }[];
    };
    expect(out.topHighRisk[0].customerName).toBeNull();
    expect(out.nested.deeper.rows[0].customerEmail).toBe("z***@example.test");
    // A field whose NAME merely starts with "customer" is not a customer field.
    expect(out.bands[0].customerCount).toBe(1);
  });

  it("keeps Dates as Dates, which a spread would have destroyed", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    const out = redactToolResult({ createdAt: at, customerName: MY_NAME }) as {
      createdAt: unknown;
    };
    expect(out.createdAt).toBeInstanceOf(Date);
    expect((out.createdAt as Date).toISOString()).toBe(at.toISOString());
  });

  it("fails CLOSED on an email field holding something that is not a string", () => {
    // The boundary walks untyped data. A number or an object in the email field
    // is a shape nobody predicted, and the only answer that cannot leak is the
    // fully masked one.
    const out = redactToolResult({
      a: { customerEmail: 12345 },
      b: { customerEmail: { raw: MY_EMAIL } },
      c: { customerEmail: [MY_EMAIL] },
      d: { customerEmail: null },
    }) as Record<string, { customerEmail: unknown }>;
    expect(out.a.customerEmail).toBe("***");
    expect(out.b.customerEmail).toBe("***");
    expect(out.c.customerEmail).toBe("***");
    expect(JSON.stringify(out)).not.toContain(MY_EMAIL);
    // Absence is not a value to hide.
    expect(out.d.customerEmail).toBeNull();
  });

  it("a field named after an Object prototype member is NOT treated as redacted", () => {
    // Why the rules live in a Map. A plain object lookup walks the prototype
    // chain, so `constructor` and `toString` would each find a function there,
    // read as "this field has a rule", and be nulled. Real data does carry keys
    // like these: a JSON blob keyed by user input can hold anything.
    const out = redactToolResult({
      constructor: "a real value",
      toString: "another real value",
      valueOf: 7,
    }) as Record<string, unknown>;
    expect(out.constructor).toBe("a real value");
    expect(out.toString).toBe("another real value");
    expect(out.valueOf).toBe(7);
  });

  it("leaves the MERCHANT's own address alone", () => {
    // The merchant reading their own settings back through their own key must
    // get their own email whole. Masking it would break the settings readers to
    // protect nobody.
    const out = redactToolResult({
      notificationEmail: "owner@merchant.test",
      senderName: "The Merchant",
      approvedByEmail: "owner@merchant.test",
    }) as Record<string, unknown>;
    expect(out.notificationEmail).toBe("owner@merchant.test");
    expect(out.senderName).toBe("The Merchant");
    expect(out.approvedByEmail).toBe("owner@merchant.test");
  });

  it("a cycle terminates and stays redacted", () => {
    // A cycle must not be the one path where the rule fails open, so the seen
    // map holds the REDACTED output rather than the raw node.
    const node: Record<string, unknown> = { customerName: MY_NAME };
    node.self = node;
    const out = redactToolResult(node) as Record<string, unknown>;
    expect(out.customerName).toBeNull();
    expect((out.self as Record<string, unknown>).customerName).toBeNull();
    expect(out.self).toBe(out);
  });
});

describe("PLANT 4: the sweep's own reader, mutated", () => {
  // 379 binding 3: mutate the reader, not only the lists. A derivation that
  // returns an empty set makes "every read tool is swept" vacuously true, and
  // the sweep above would pass having driven nothing at all.
  it("the derived read set is non-empty and is the registry minus the writes", () => {
    expect(READ_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(READ_TOOL_NAMES.length).toBe(
      MERCHANT_TOOL_NAMES.length - MERCHANT_WRITE_TOOL_NAMES.length,
    );
    // And the two halves genuinely partition, so a write tool cannot hide in the
    // read set by being missing from the write list.
    for (const name of READ_TOOL_NAMES) {
      expect(MERCHANT_WRITE_TOOL_NAMES, `${name} is on both sides`).not.toContain(name);
    }
  });

  it("the args map covers the read set in BOTH directions", () => {
    const covered = Object.keys(READ_TOOL_ARGS).sort();
    expect(covered).toEqual([...READ_TOOL_NAMES].sort());
  });

  it("the positive control names only tools that are actually registered", () => {
    for (const name of TOOLS_THAT_MUST_RETURN_A_CUSTOMER) {
      expect(READ_TOOL_NAMES, `${name} is not a registered read tool`).toContain(name);
    }
  });
});
