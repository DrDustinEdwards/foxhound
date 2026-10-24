import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, customerContext, disputes, failedPayments, recoverySteps } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import {
  type McpToolRegistry,
} from "~/lib/mcp/registry";
import { redactToolResult } from "~/lib/mcp/redact";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, toolOutput } from "./helpers/mcp-client";

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
// (Those were the pre-regroup names. After the 2026-10-10 regroup the same
// views ship as foxhound_list_disputes, foxhound_get_intelligence and
// foxhound_get_overview, and foxhound_get_payment is a new reader whose detail
// carries the raw failed-payment row, name and email included.)
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
// scored at 12, and every failed payment carries the customer's name.

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
 *
 * Every id argument names one of MINE's real rows, so each call answers with
 * data rather than with a "not found" tool error: an error answer carries no
 * customer row and would pass the sweep for the wrong reason, which is why the
 * sweep also asserts no read came back isError.
 */
const READ_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  foxhound_get_overview: {},
  foxhound_list_payments: {},
  foxhound_get_payment: { payment_id: `fp_${MINE}` },
  foxhound_list_customers: {},
  foxhound_get_customer: { stripe_customer_id: `cus_${MINE}` },
  foxhound_get_intelligence: {},
  foxhound_list_disputes: {},
  foxhound_review_audits: {},
  foxhound_get_billing: {},
  foxhound_get_settings: {},
};

/**
 * THE POSITIVE CONTROL, and it is not the guard.
 *
 * The sweep asserts an ABSENCE, and an absence passes trivially against an empty
 * list. These are the tools the fixture puts a customer row into, so each must
 * come back carrying the customer id: that is what proves the sweep had
 * something to discriminate on rather than seven empty arrays. The guard itself
 * stays derived over the whole registry.
 */
const TOOLS_THAT_MUST_RETURN_A_CUSTOMER = [
  "foxhound_get_overview",
  "foxhound_list_payments",
  "foxhound_get_payment",
  "foxhound_list_customers",
  "foxhound_get_customer",
  "foxhound_get_intelligence",
  "foxhound_list_disputes",
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
      // The name too, because foxhound_get_payment returns the failed-payment
      // ROW (`db.select()`), and a fixture with a null name here would let that
      // tool pass the sweep with nothing to hide.
      customerName: name,
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
    // A sent recovery email, whose text greets the customer by name and whose
    // send error names their address. foxhound_get_payment returns the steps,
    // and the redactor deliberately leaves Foxhound's own text alone (383), so
    // only the tool's step projection keeps these off the wire.
    await db.insert(recoverySteps).values({
      id: `rs_${account}`,
      failedPaymentId: `fp_${account}`,
      accountId: account,
      stepType: "email",
      stepNumber: 1,
      scheduledAt: NOW,
      executedAt: NOW,
      aiSubject: `${name}, your payment did not go through`,
      aiBodyHtml: `<p>Hi ${name},</p>`,
      customBody: `Dear ${name}`,
      lastAttemptError: `bounced: ${email}`,
    });
  }
  return { db, tokens };
}

/** One tools/call through the REAL handler and the SDK, read back as the bytes
 *  the agent would receive (the JSON-RPC message, whichever era answered). */
async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  registry: McpToolRegistry = MERCHANT_TOOLS,
) {
  const res = (await handleMcpRequest(
    mcpRequest({ token, method: "tools/call", params: { name, arguments: args } }),
    env(),
    registry,
  )) as Response;
  const answer = await readMcp(res);
  return { status: answer.status, text: answer.text, ...toolOutput(answer) };
}

/** The read half of the registry, DERIVED: everything registered, minus the
 *  writes that name themselves. Never a hand-kept list of reads. */
const READ_TOOL_NAMES = MERCHANT_TOOL_NAMES.filter(
  (name) => !MERCHANT_WRITE_TOOL_NAMES.includes(name),
);



/** The source of the tool module, comments stripped, so a sentence ABOUT the
 *  redactor (the header says where it lives) is not mistaken for a use of it. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** What "the tool module does its own masking" looks like in code: an import of
 *  the redactor, a call to either of its functions, or a hand-rolled mask. */
function maskingIn(code: string): string[] {
  const found: string[] = [];
  if (/from\s+["'][^"']*\/redact["']/.test(code)) found.push("imports the redactor");
  if (/\b(redactToolResult|maskEmail)\b/.test(code)) found.push("calls a redactor function");
  if (/REDACTED_CUSTOMER_FIELDS/.test(code)) found.push("reads the redaction constant");
  if (/\*\*\*/.test(code)) found.push("writes a mask by hand");
  return found;
}

const TOOLS_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/lib/mcp/tools.server.ts", import.meta.url)),
  "utf8",
);

// ============================================================================

describe("PLANT 1: no read tool returns a customer name or a raw email", () => {

  it("the sweep had something to find: the customer-carrying tools returned rows", async () => {
    const { tokens } = await seed();
    // Without this, PLANT 1 passes on seven empty arrays. This is the positive
    // control for the fixture, not a second copy of the guard.
    for (const name of TOOLS_THAT_MUST_RETURN_A_CUSTOMER) {
      const { text, isError } = await callTool(tokens[MINE], name, READ_TOOL_ARGS[name]);
      expect(isError, `${name} answered with a tool error: ${text}`).toBe(false);
      expect(text, `${name} returned nothing to redact`).toContain(`cus_${MINE}`);
    }
  });

  it("foxhound_get_payment's detail keeps both fields, nulled and masked, on failedPayment", async () => {
    const { tokens } = await seed();
    // The new reader returns the failed-payment ROW, which is the one place on
    // the endpoint a customer name rides on a payment rather than a customer.
    // Asserted on the structured result as well as the bytes, so the field is
    // proved present-and-redacted rather than merely absent from the text.
    const { text, isError, data } = await callTool(tokens[MINE], "foxhound_get_payment", {
      payment_id: `fp_${MINE}`,
    });
    expect(isError, text).toBe(false);
    const failedPayment = data.failedPayment as Record<string, unknown>;
    expect(failedPayment.id).toBe(`fp_${MINE}`);
    expect("customerName" in failedPayment).toBe(true);
    expect(failedPayment.customerName).toBeNull();
    expect(failedPayment.customerEmail).toBe("z***@example.test");
    expect(failedPayment.amountCents).toBe(9900);
    expect(text).not.toContain(MY_NAME);
    expect(text).not.toContain(MY_EMAIL);
  });
});

describe("PLANT 2: REGISTRATION is what redacts, so a tool nobody has written yet is covered", () => {

  it("the tool module contains NO masking of its own: the boundary is the one authority", () => {
    // 381 binding e: one authority, not two. If tools.server.ts masked a field
    // itself, a plant that broke the registry wrap could be held up by that
    // second copy and the wire assertion would stay green while proving nothing
    // about the boundary. So the tool module may choose which fields to return,
    // never disguise one. Scanned as CODE, comments stripped, because its header
    // rightly says where the redactor lives.
    expect(maskingIn(codeOf(TOOLS_SOURCE))).toEqual([]);
  });

  it("the source scan discriminates: each kind of masking, planted, is found", () => {
    // The scan above asserts an absence too, so it gets its own positive
    // control: every shape it claims to catch is planted into the real source
    // and must be reported, and one planted only in a comment must not be.
    const code = codeOf(TOOLS_SOURCE);
    const plants: [string, string][] = [
      ['import { redactToolResult } from "./redact";\n', "imports the redactor"],
      ["const x = maskEmail(row.customerEmail);\n", "calls a redactor function"],
      ["const fields = Object.keys(REDACTED_CUSTOMER_FIELDS);\n", "reads the redaction constant"],
      ['const masked = `${e[0]}***${e.slice(e.indexOf("@"))}`;\n', "writes a mask by hand"],
    ];
    for (const [plant, finding] of plants) {
      expect(maskingIn(codeOf(plant + code)), plant).toContain(finding);
    }
    expect(maskingIn(codeOf(`// maskEmail(x) from "./redact"\n${code}`))).toEqual([]);
  });
});

describe("PLANT 3: the walk itself", () => {

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

describe("PLANT 5: what the tools choose not to return", () => {
  it("foxhound_get_payment returns each step's facts and never the email Foxhound wrote", async () => {
    const { tokens } = await seed();
    const { isError, data, text } = await callTool(tokens[MINE], "foxhound_get_payment", {
      payment_id: `fp_${MINE}`,
    });
    expect(isError).toBe(false);
    const steps = data.steps as Record<string, unknown>[];
    // The step is there, so the absence below is the projection and not an
    // empty list.
    expect(steps.map((step) => step.id)).toEqual([`rs_${MINE}`]);
    for (const field of ["aiSubject", "aiBodyHtml", "customBody", "lastAttemptError"]) {
      expect(text, field).not.toContain(field);
    }
    expect(text).not.toContain("Zebulon");
    expect(text).not.toContain(MY_EMAIL);
  });
});
