import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, customerContext, failedPayments } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { MCP_PROTOCOL_VERSION } from "~/lib/mcp/protocol";
import { maskEmail, redactCustomerFields, redactPaymentFields } from "~/lib/mcp/redact";
import { isDeniedToolName } from "~/lib/mcp/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";

// SESSION 77: THE THIRTEEN READ TOOLS, under 370's DEFAULT-REDACT.
//
// THE TWO PROPERTIES THAT MATTER, and everything below serves one of them:
//
//   1. A KEY READS ITS OWN ACCOUNT AND NOTHING ELSE. Every tool is driven with a
//      two-account fixture where the OTHER account holds data that would be
//      obviously wrong to return. A tool that leaked would return rows, not an
//      empty list, so the assertion discriminates.
//   2. NO CUSTOMER NAME OR RAW EMAIL LEAVES THE ENDPOINT. Asserted over the
//      RESPONSE BYTES rather than field by field, because a field-by-field check
//      is a guess about which field the next helper will add.
//
// STACKED-GUARD FIXTURES (371 binding 5). Where a refusal has a neighbour that
// would refuse the same input anyway, the fixture is built so only the guard
// under test can produce the result. That rule exists because neutering the
// admin-scope check in session 76 left the suite green.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { handleMcpRequest } = await import("~/lib/mcp/handler.server");
const { hashMcpToken } = await import("~/lib/auth/mcp-tokens");
const { MERCHANT_TOOLS, MERCHANT_TOOL_NAMES } = await import("~/lib/mcp/tools.server");

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

/** Source with comments stripped. The tools module's own header NAMES the
 *  writers it must not contain, in order to explain why it does not contain
 *  them, so a raw absence grep fails on the explanation. Session 57's trap, and
 *  this suite walked into it on its first run despite the campaign having
 *  recorded it three times. */
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

/** Values that must never appear in a response. Deliberately distinctive, so a
 *  substring search over the bytes cannot match by accident. */
const MY_NAME = "Zebulon Quicksilver";
const MY_EMAIL = "zebulon.quicksilver@example.test";
const THEIR_NAME = "Persephone Nightingale";
const THEIR_EMAIL = "persephone.nightingale@other.test";

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
      healthScore: 42,
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
  }
  return { db, tokens };
}

async function call(token: string | null, method: string, params: unknown = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = (await handleMcpRequest(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env(),
    MERCHANT_TOOLS,
  )) as Response;
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

const callTool = (token: string, name: string, args: Record<string, unknown> = {}) =>
  call(token, "tools/call", { name, arguments: args });

// ============================================================================

describe("PLANT 1: the tools are registered and describable", () => {
  it("tools/list returns exactly seventeen, with schemas that parse", async () => {
    const { tokens } = await seed();
    const { status, json } = await call(tokens[MINE], "tools/list");
    expect(status).toBe(200);
    const tools = (json as { result: { tools: { name: string; inputSchema: unknown }[] } }).result
      .tools;
    expect(tools).toHaveLength(18);
    expect(tools.map((t) => t.name).sort()).toEqual([...MERCHANT_TOOL_NAMES].sort());
    for (const tool of tools) {
      // Every schema round-trips as JSON and is an object schema, which is what
      // the spec requires of inputSchema.
      const parsed = JSON.parse(JSON.stringify(tool.inputSchema)) as { type: string };
      expect(parsed.type, `${tool.name} schema`).toBe("object");
    }
  });

  it("the list carries NO executor, checked BEFORE serialization", async () => {
    // THIS ASSERTION WAS VACUOUS ON ITS FIRST CUT AND ITS OWN MUTATION CAUGHT
    // IT. It checked the PARSED response, and `JSON.stringify` silently drops
    // function-valued properties, so returning the raw tool objects from
    // `list()` left it green. The property worth guarding is what the registry
    // HANDS BACK, which a future consumer might not serialize at all: a logger,
    // a cache, or an SDK that reflects over the object.
    const descriptors = MERCHANT_TOOLS.list() as unknown as Record<string, unknown>[];
    expect(descriptors).toHaveLength(18);
    for (const descriptor of descriptors) {
      expect(Object.keys(descriptor).sort()).toEqual(["description", "inputSchema", "name"]);
      expect("execute" in descriptor).toBe(false);
    }
    // And the wire form agrees, which is the weaker half kept for completeness.
    const { tokens } = await seed();
    const { text } = await call(tokens[MINE], "tools/list");
    expect(text).not.toContain("execute");
  });

  it("every name is one verb_noun vocabulary, and none is on the denylist", () => {
    for (const name of MERCHANT_TOOL_NAMES) {
      expect(name, `${name} is not snake_case`).toMatch(/^[a-z]+(_[a-z]+)+$/);
      // THREE VERBS SINCE SESSION 79: the four write tools use `set_`. The
      // vocabulary is still closed, which is the property, and widening it is a
      // deliberate edit rather than a relaxation to any prefix.
      expect(
        name.startsWith("list_") || name.startsWith("get_") || name.startsWith("set_"),
        `${name} verb`,
      ).toBe(true);
      expect(isDeniedToolName(name), `${name} is denied`).toBe(false);
    }
  });

  it("every description says what it returns AND what it cannot do where a write is adjacent", () => {
    // The descriptions are an agent's only documentation, and the ones that sit
    // next to a HUMAN-FOREVER refusal have to say so or an agent will try.
    const byName = new Map(MERCHANT_TOOLS.list().map((t) => [t.name, t.description]));
    expect(byName.get("get_alerts")).toContain("Cannot create, enable or delete");
    expect(byName.get("list_disputes")).toContain("Cannot submit evidence");
    expect(byName.get("get_billing")).toContain("Cannot issue, pay or void");
    expect(byName.get("list_connections")).toContain("cannot be connected or disconnected");
    expect(byName.get("get_audit_settings")).toContain("Cannot change them");
    for (const [name, description] of byName) {
      expect(description.length, `${name} description too short`).toBeGreaterThan(40);
      expect(description, `${name} has a wide dash`).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe("PLANT 2: every tool reads the key's account and only it", () => {
  it("EACH OF THE THIRTEEN, driven end to end with two accounts seeded", async () => {
    // PARAMETERIZED OVER THE SHIPPED LIST, so a fourteenth tool is covered the
    // day it is added. The other account's data is present and distinctive, so a
    // leak returns rows rather than an empty list.
    const { tokens } = await seed();
    const argsFor: Record<string, Record<string, unknown>> = {
      get_audit_run: { run_id: "does_not_exist" },
      get_customer_health: { stripe_customer_id: `cus_${MINE}` },
    };

    for (const name of MERCHANT_TOOL_NAMES) {
      const { status, text } = await callTool(tokens[MINE], name, argsFor[name] ?? {});
      expect(status, `${name} did not answer`).toBe(200);
      // THE OTHER ACCOUNT APPEARS NOWHERE in the bytes: not its id, not its
      // customer, not its name or email.
      expect(text, `${name} leaked the other account id`).not.toContain(THEIRS);
      expect(text, `${name} leaked the other customer`).not.toContain(`cus_${THEIRS}`);
      expect(text, `${name} leaked a foreign name`).not.toContain(THEIR_NAME);
      expect(text, `${name} leaked a foreign email`).not.toContain(THEIR_EMAIL);
    }
  });

  it("and the SAME tools answer differently for the other key, so the scoping is real", async () => {
    // Without this, thirteen assertions that "theirs" is absent would be
    // satisfied by thirteen tools that return nothing at all.
    const { tokens } = await seed();
    const mine = await callTool(tokens[MINE], "list_customers");
    const theirs = await callTool(tokens[THEIRS], "list_customers");
    expect(mine.text).toContain(`cus_${MINE}`);
    expect(theirs.text).toContain(`cus_${THEIRS}`);
    expect(mine.text).not.toContain(`cus_${THEIRS}`);
    expect(theirs.text).not.toContain(`cus_${MINE}`);
  });

  it("NO TOOL ACCEPTS AN ACCOUNT ARGUMENT, so none can be talked into another one", async () => {
    // The stacked-guard case: the helpers pin the account themselves, so a tool
    // that DID take the argument might still be safe. The fixture makes the
    // guard under test the only thing that could matter, by passing the other
    // account under every plausible spelling.
    const { tokens } = await seed();
    for (const key of ["account_id", "accountId", "account"]) {
      const { text } = await callTool(tokens[MINE], "list_customers", { [key]: THEIRS });
      expect(text, `${key} was honoured`).not.toContain(`cus_${THEIRS}`);
      expect(text).toContain(`cus_${MINE}`);
    }
    // And no schema advertises one.
    for (const tool of MERCHANT_TOOLS.list()) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      for (const prop of props) {
        expect(prop.toLowerCase(), `${tool.name} takes ${prop}`).not.toContain("account");
      }
    }
  });
});

describe("PLANT 3: the redaction default (370)", () => {
  it("THE THREE PII TOOLS RETURN NO NAME AND NO RAW EMAIL, over the response bytes", async () => {
    const { tokens } = await seed();
    for (const [name, args] of [
      ["list_customers", {}],
      ["get_customer_health", { stripe_customer_id: `cus_${MINE}` }],
      ["list_failed_payments", {}],
    ] as const) {
      const { text } = await callTool(tokens[MINE], name, args);
      // DERIVED OVER THE BYTES, not field by field: a field-by-field check is a
      // guess about which field the next helper version will add.
      expect(text, `${name} leaked the name`).not.toContain(MY_NAME);
      expect(text, `${name} leaked the raw email`).not.toContain(MY_EMAIL);
      // And the correlation key survives, which is the half that makes the tool
      // useful rather than merely safe.
      expect(text, `${name} dropped the customer id`).toContain(`cus_${MINE}`);
    }
  });

  it("the masked form is present, so the redaction is masking and not deletion", async () => {
    const { tokens } = await seed();
    const { text } = await callTool(tokens[MINE], "list_customers");
    expect(text).toContain("z***@example.test");
  });

  it("the masker itself: first character plus domain, and a malformed address fails CLOSED", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("")).toBeNull();
    // No @, a trailing @, or a leading @: none can be masked by the rule, and
    // passing them through unchanged would be the one path a raw value escapes.
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("trailing@")).toBe("***");
    expect(maskEmail("@leading.test")).toBe("***");
  });

  it("the redactors null the name and never merely omit it", () => {
    const out = redactCustomerFields({
      stripeCustomerId: "cus_1",
      customerName: "Real Name",
      customerEmail: "real@example.test",
      mrrContributionCents: 100,
    });
    expect(out.customerName).toBeNull();
    expect("customerName" in out).toBe(true);
    expect(out.customerEmail).toBe("r***@example.test");
    // Everything else passes through untouched.
    expect(out.mrrContributionCents).toBe(100);
    expect(out.stripeCustomerId).toBe("cus_1");

    const payment = redactPaymentFields({
      stripeCustomerId: "cus_1",
      customerEmail: "real@example.test",
      amountCents: 500,
    });
    expect(payment.customerEmail).toBe("r***@example.test");
    expect(payment.amountCents).toBe(500);
  });

  it("ONE IMPLEMENTATION: no tool masks inline", () => {
    // Three inline maskers would be three places for the rule to drift, with
    // only the one somebody re-read staying correct.
    const tools = code(read("app/lib/mcp/tools.server.ts"));
    expect(tools).toContain('from "./redact"');
    expect(tools).not.toContain("lastIndexOf(\"@\")");
    expect(tools).not.toContain("***");
  });
});

describe("PLANT 4: failures are tool errors, not transport throws", () => {
  it("a missing required argument comes back as a tool error the agent can fix", async () => {
    const { tokens } = await seed();
    const { status, json } = await callTool(tokens[MINE], "get_customer_health", {});
    // 200 with isError, not a JSON-RPC error: MCP reserves protocol errors for
    // protocol failures, and this is the caller's argument mistake.
    expect(status).toBe(200);
    const result = (json as { result: { isError?: boolean; structuredContent: { error: string } } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toContain("stripe_customer_id");
  });

  it("an unknown tool is still a PROTOCOL error, which is the other side of the line", async () => {
    const { tokens } = await seed();
    const { status, json } = await callTool(tokens[MINE], "no_such_tool");
    expect(status).toBe(404);
    expect((json as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("a helper that throws does not take the transport down", async () => {
    const { tokens } = await seed();
    // A run id that does not exist returns null rather than throwing, so the
    // tool answers cleanly. The point is that the transport stayed 200.
    const { status, json } = await callTool(tokens[MINE], "get_audit_run", { run_id: "nope" });
    expect(status).toBe(200);
    expect(
      (json as { result: { structuredContent: { run: unknown } } }).result.structuredContent.run,
    ).toBeNull();
  });
});

describe("PLANT 5: the end to end, through the real transport", () => {
  it("initialize, tools/list, then three tools/call round-trips on one key", async () => {
    const { tokens } = await seed();

    const init = await call(tokens[MINE], "initialize", { protocolVersion: "2025-06-18" });
    expect(init.status).toBe(200);
    expect(
      (init.json as { result: { protocolVersion: string } }).result.protocolVersion,
    ).toBe("2025-06-18");

    const list = await call(tokens[MINE], "tools/list");
    expect((list.json as { result: { tools: unknown[] } }).result.tools).toHaveLength(18);

    for (const [name, args] of [
      ["get_audit_settings", {}],
      ["list_customers", {}],
      ["list_failed_payments", {}],
    ] as const) {
      const { status, json } = await callTool(tokens[MINE], name, args);
      expect(status, name).toBe(200);
      const result = (json as { result: { isError?: boolean; structuredContent: unknown } }).result;
      expect(result.isError, `${name} errored`).toBeUndefined();
      expect(result.structuredContent, `${name} returned nothing`).toBeTruthy();
    }
  });

  it("and NONE of it works without a key", async () => {
    await seed();
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const { status } = await call(null, method);
      expect(status, `${method} without a key`).toBe(401);
    }
  });

  it("the modern era still round-trips its version header with tools registered", async () => {
    const { tokens } = await seed();
    const res = (await handleMcpRequest(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens[MINE]}`,
          "Content-Type": "application/json",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: { "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION },
          },
        }),
      }),
      env(),
      MERCHANT_TOOLS,
    )) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("MCP-Protocol-Version")).toBe(MCP_PROTOCOL_VERSION);
  });
});

describe("PLANT 6: the tools stay read-only", () => {
  it("no writer, no money path, no outcome, in the tool module", () => {
    const tools = code(read("app/lib/mcp/tools.server.ts"));
    for (const forbidden of [
      "executeMoneyWrite",
      "recordOutcome",
      "saveAuditRun",
      "createAlert",
      "setAlertEnabled",
      "deleteAlert",
      "createAccountApiKey",
      "revokeAccountApiKey",
      "submitDisputeEvidence",
      "deauthorize",
      "db.insert",
      "db.update",
      "db.delete",
    ]) {
      expect(tools, `${forbidden} reached the tools`).not.toContain(forbidden);
    }
  });
});

describe("PLANT 7: the copy release, and every earlier state gone", () => {
  const flatten = (guide: (typeof DOC_GUIDES)[number]) =>
    JSON.stringify(guide.sections);

  const platform = flatten(DOC_GUIDES.find((g) => g.slug === "platform")!);
  const s29 = read("app/routes/app/settings/api-keys.tsx");
  const llms = read("app/routes/files/llms.ts");

  it("S29 describes a live endpoint, its four writes, and the redaction default", () => {
    // MOVED IN SESSION 79. "read-only" and "cannot change anything" were true of
    // the thirteen and became false the moment four write tools shipped; a copy
    // carrier that kept them would be understating what a key grants, which is
    // the same defect as overstating it.
    expect(s29).toContain("/mcp");
    expect(s29).toContain("change four settings");
    expect(s29).toContain("Every change it makes is logged with");
    expect(s29).toContain("cannot move money");
    expect(s29).toContain("customer names and full email addresses are");
    expect(s29).not.toContain("cannot change anything");
  });

  it("THE OVER-PROMISE THAT 368 NAMED IS GONE, in its exact words", () => {
    // "Connect Foxhound data to external AI agents and automations" described a
    // transport that 404'd. The endpoint exists now; the sentence that promised
    // it before it did must not survive alongside its replacement.
    expect(s29).not.toContain("Connect Foxhound data to external AI agents and automations.");
    expect(platform).not.toContain("credentials for external AI agents and automations");
  });

  it("the docs say where the endpoint is, what it reads, and what it cannot do", () => {
    expect(platform).toContain("foxhoundapp.com/mcp");
    expect(platform).toContain("Most of the tools READ");
    expect(platform).toContain("Four tools WRITE");
    expect(platform).toContain("Every change an agent makes is recorded with the key");
    expect(platform).not.toContain("The tools are READ ONLY");
    expect(platform).toContain("absent by construction");
    expect(platform).toContain("Customer names are never sent");
  });

  it("llms.txt gains its MCP section in the file's own voice", () => {
    expect(llms).toContain("## For agents");
    expect(llms).toContain("Model Context Protocol endpoint at ${url}/mcp");
    expect(llms).toContain("Settings and API keys");
    expect(llms).toContain("Most tools read");
    expect(llms).toContain("Four tools write, and only to settings");
    expect(llms).not.toContain("The tools are READ ONLY");
    expect(llms).toContain("masked to their first character and domain");
  });

  it("and the HUMAN-FOREVER five are named to an agent as absent, not as forbidden", () => {
    // "Those do not exist rather than being switched off" is the honest framing
    // and the one that survives a jailbreak attempt: there is nothing to unlock.
    for (const source of [platform, llms]) {
      expect(source).toMatch(/submits dispute evidence/);
      expect(source).toMatch(/cancels an account/);
      expect(source).toMatch(/disconnects Stripe/);
      expect(source).toMatch(/issues another key/);
    }
  });
});
