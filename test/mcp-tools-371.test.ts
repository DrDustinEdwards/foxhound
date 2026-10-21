import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, customerContext, failedPayments } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { DOC_GUIDES } from "~/lib/marketing/docs-content";
import { maskEmail, redactToolResult } from "~/lib/mcp/redact";
import { isDeniedToolName } from "~/lib/mcp/registry";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { MODERN_VERSION, mcpRequest, readMcp, toolOutput, type McpCallInit } from "./helpers/mcp-client";

// SESSION 77: THE THIRTEEN READ TOOLS, under 370's DEFAULT-REDACT. The read
// count is fifteen since session 83 added 375's two approved readers, and the
// redaction moved to the registry boundary in the same session (376 item 7).
// The 2026-10-10 MCP ruling (job_874dc20ea9ac) regrouped all twenty-three into
// twelve foxhound_{action}_{resource} tools, ten reads and two writes, served
// through the official SDK; every plant below was carried over to the new names.
//
// THE TWO PROPERTIES THAT MATTER, and everything below serves one of them:
//
//   1. A KEY READS ITS OWN ACCOUNT AND NOTHING ELSE. Every tool is driven with a
//      two-account fixture where the OTHER account holds data that would be
//      obviously wrong to return. A tool that leaked would return rows, not an
//      empty list, so the assertion discriminates.
//   2. NO CUSTOMER NAME OR RAW EMAIL LEAVES THE ENDPOINT. Asserted over the
//      RESPONSE BYTES rather than field by field, because a field-by-field check
//      is a guess about which field the next helper will add. Since the SDK
//      answers a legacy-era request as an SSE stream, "the bytes" is the JSON-RPC
//      message `readMcp` lifts out of it, which is everything the agent reads.
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
const { MERCHANT_TOOLS, MERCHANT_TOOL_NAMES, MERCHANT_WRITE_TOOL_NAMES } = await import(
  "~/lib/mcp/tools.server"
);

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

/** Values that must never appear in a response. Deliberately distinctive, so a
 *  substring search over the bytes cannot match by accident. */
const MY_NAME = "Zebulon Quicksilver";
const MY_EMAIL = "zebulon.quicksilver@example.test";
const THEIR_NAME = "Persephone Nightingale";
const THEIR_EMAIL = "persephone.nightingale@other.test";

const WIDE_DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];

function env(): Env {
  return {
    DB: {},
    RATE_LIMITER: {
      idFromName: (n: string) => n,
      get: () => ({ check: async () => ({ allowed: true, retryAfterSec: 60 }) }),
    },
  } as unknown as Env;
}

/** Two accounts, each with one customer and one failed payment. `extraPayments`
 *  adds that many more failed payments to MINE only, for the pagination plant. */
async function seed(extraPayments = 0) {
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
      // The payment row carries a name column too, so the redaction plant covers
      // a name arriving from the payment side and not only from the customer.
      customerName: name,
      customerEmail: email,
      amountCents: 9900,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      detectedAt: NOW,
      accountId: account,
    });
  }
  for (let i = 0; i < extraPayments; i++) {
    await db.insert(failedPayments).values({
      id: `fp_${MINE}_extra_${i}`,
      stripeEventId: `evt_${MINE}_extra_${i}`,
      stripeInvoiceId: `in_${MINE}_extra_${i}`,
      stripeCustomerId: `cus_${MINE}`,
      customerEmail: MY_EMAIL,
      amountCents: 1000 + i,
      currency: "usd",
      declineCategory: "soft",
      status: "active",
      // Distinct times, so "newest first" is a total order and pages cannot
      // overlap because of a tie.
      detectedAt: new Date(NOW.getTime() - (i + 1) * 60_000),
      accountId: MINE,
    });
  }
  return { db, tokens };
}

async function call(token: string | null, method: string, params: Record<string, unknown> = {}, init: McpCallInit = {}) {
  const res = (await handleMcpRequest(mcpRequest({ token, method, params, ...init }), env(), MERCHANT_TOOLS)) as Response;
  return readMcp(res);
}

const callTool = (token: string, name: string, args: Record<string, unknown> = {}) =>
  call(token, "tools/call", { name, arguments: args });

type ListedTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown> };
  annotations: Record<string, unknown>;
};

// ============================================================================

describe("PLANT 1: the tools are registered and describable", () => {
  it("tools/list returns exactly twelve, with schemas that parse", async () => {
    const { tokens } = await seed();
    const { status, json } = await call(tokens[MINE], "tools/list");
    expect(status).toBe(200);
    const tools = (json as { result: { tools: ListedTool[] } }).result.tools;
    expect(tools).toHaveLength(12);
    expect(MERCHANT_TOOL_NAMES).toHaveLength(12);
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
    // a cache, or an SDK that reflects over the object (the SDK now does
    // exactly that, reading each descriptor to register it).
    const descriptors = MERCHANT_TOOLS.list() as unknown as Record<string, unknown>[];
    expect(descriptors).toHaveLength(12);
    for (const descriptor of descriptors) {
      expect(Object.keys(descriptor).sort()).toEqual([
        "annotations",
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
      expect("execute" in descriptor).toBe(false);
      for (const value of Object.values(descriptor)) {
        expect(typeof value, `${String(descriptor.name)} carries a function`).not.toBe("function");
      }
    }
    // And the wire form agrees, which is the weaker half kept for completeness.
    const { tokens } = await seed();
    const { text } = await call(tokens[MINE], "tools/list");
    expect(text).not.toContain("execute");
  });

  it("every name is foxhound_{action}_{resource} from a closed action set, and none is on the denylist", () => {
    // THE VOCABULARY IS STILL CLOSED, which is the property the old verb plant
    // held: widening it is a deliberate edit, never a relaxation to any prefix.
    // The pattern is written out here rather than imported from the registry,
    // so loosening the registry's rule cannot loosen this plant with it.
    const ACTIONS = ["get", "list", "review", "update", "manage"];
    for (const name of MERCHANT_TOOL_NAMES) {
      expect(name, `${name} is not foxhound_{action}_{resource}`).toMatch(/^foxhound(_[a-z]+){2,}$/);
      const action = name.split("_")[1];
      expect(ACTIONS, `${name} action`).toContain(action);
      expect(isDeniedToolName(name), `${name} is denied`).toBe(false);
    }
  });

  it("every description says what it returns AND what it cannot do where a forbidden action is adjacent", () => {
    // The descriptions are an agent's only documentation, and the ones that sit
    // next to a HUMAN-FOREVER refusal have to say so or an agent will try.
    const byName = new Map(MERCHANT_TOOLS.list().map((t) => [t.name, t.description]));
    expect(byName.get("foxhound_list_disputes")).toContain("cannot submit evidence");
    expect(byName.get("foxhound_get_billing")).toContain("cannot issue, pay, adjust or void");
    expect(byName.get("foxhound_get_overview")).toContain("nothing can be connected or disconnected");
    expect(byName.get("foxhound_get_payment")).toContain("Cannot retry, pause, resume or cancel recovery");
    for (const [name, description] of byName) {
      expect(description.length, `${name} description too short`).toBeGreaterThan(40);
      for (const dash of WIDE_DASHES) {
        expect(description, `${name} has a wide dash`).not.toContain(dash);
      }
    }
  });

  it("every tool carries all four behaviour hints, set honestly, in the registry AND on the wire", async () => {
    // A missing hint is read by a client as the spec default, and the default
    // for destructiveHint is true, so an omission would be a statement nobody
    // made (ruling rule 6). The write set is the module's own export; the
    // count pins it, so a third write cannot arrive by being listed there.
    expect([...MERCHANT_WRITE_TOOL_NAMES].sort()).toEqual([
      "foxhound_manage_alerts",
      "foxhound_update_settings",
    ]);
    const writes = new Set<string>(MERCHANT_WRITE_TOOL_NAMES);
    const check = (tools: { name: string; annotations: Record<string, unknown> }[]) => {
      for (const tool of tools) {
        for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
          expect(typeof tool.annotations?.[hint], `${tool.name} ${hint}`).toBe("boolean");
        }
        if (writes.has(tool.name)) {
          expect(tool.annotations.readOnlyHint, `${tool.name} readOnlyHint`).toBe(false);
        } else {
          expect(tool.annotations.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
          expect(tool.annotations.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
        }
      }
    };
    check(MERCHANT_TOOLS.list() as unknown as { name: string; annotations: Record<string, unknown> }[]);
    // The SDK could drop or rewrite them on the way out, so the wire is checked
    // separately rather than assumed.
    const { tokens } = await seed();
    const { json } = await call(tokens[MINE], "tools/list");
    const wire = (json as { result: { tools: ListedTool[] } }).result.tools;
    expect(wire).toHaveLength(12);
    check(wire);
  });
});

describe("PLANT 2: every tool reads the key's account and only it", () => {
  it("EACH REGISTERED TOOL, driven end to end with two accounts seeded", async () => {
    // PARAMETERIZED OVER THE SHIPPED LIST, so the next tool is covered the
    // day it is added. The other account's data is present and distinctive, so a
    // leak returns rows rather than an empty list. The two writes are driven
    // with no section or action, which they refuse before touching anything;
    // their refusal sentence is still bytes an agent reads.
    const { tokens } = await seed();
    const argsFor: Record<string, Record<string, unknown>> = {
      foxhound_get_payment: { payment_id: `fp_${MINE}` },
      foxhound_get_customer: { stripe_customer_id: `cus_${MINE}` },
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
    // Without this, an assertion per tool that "theirs" is absent would be
    // satisfied by a registry of tools that return nothing at all.
    const { tokens } = await seed();
    for (const name of ["foxhound_list_customers", "foxhound_list_payments"]) {
      const mine = await callTool(tokens[MINE], name);
      const theirs = await callTool(tokens[THEIRS], name);
      expect(mine.text, name).toContain(`cus_${MINE}`);
      expect(theirs.text, name).toContain(`cus_${THEIRS}`);
      expect(mine.text, name).not.toContain(`cus_${THEIRS}`);
      expect(theirs.text, name).not.toContain(`cus_${MINE}`);
    }
  });

  it("another account's ids read as not found, never as their row", async () => {
    // The id-taking reads are where a missing account predicate would show:
    // the foreign row EXISTS, so only the account pin can turn it away.
    const { tokens } = await seed();
    for (const [name, args] of [
      ["foxhound_get_payment", { payment_id: `fp_${THEIRS}` }],
      ["foxhound_get_customer", { stripe_customer_id: `cus_${THEIRS}` }],
    ] as const) {
      const answer = await callTool(tokens[MINE], name, args);
      expect(toolOutput(answer).isError, `${name} returned a foreign row`).toBe(true);
      expect(answer.text, `${name} leaked a foreign name`).not.toContain(THEIR_NAME);
      expect(answer.text, `${name} leaked a foreign email`).not.toContain(THEIR_EMAIL);
      // And the same id works for its owner, so the refusal is the pin and not
      // a broken tool.
      const own = await callTool(tokens[THEIRS], name, args);
      expect(toolOutput(own).isError, `${name} refused its owner`).toBe(false);
    }
  });

  it("NO TOOL ACCEPTS AN ACCOUNT ARGUMENT, so none can be talked into another one", async () => {
    // The stacked-guard case: the helpers pin the account themselves, so a tool
    // that DID take the argument might still be safe. The fixture makes the
    // guard under test the only thing that could matter, by passing the other
    // account under every plausible spelling.
    const { tokens } = await seed();
    for (const key of ["account_id", "accountId", "account"]) {
      const { text } = await callTool(tokens[MINE], "foxhound_list_customers", { [key]: THEIRS });
      expect(text, `${key} was honoured`).not.toContain(`cus_${THEIRS}`);
      expect(text).toContain(`cus_${MINE}`);
    }
    // And no schema advertises one, at any depth: the settings writer's
    // sections are nested objects with properties of their own.
    const propsOf = (schema: unknown): string[] => {
      const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
      return Object.entries(properties).flatMap(([prop, sub]) => [prop, ...propsOf(sub)]);
    };
    for (const tool of MERCHANT_TOOLS.list()) {
      for (const prop of propsOf(tool.inputSchema)) {
        expect(prop.toLowerCase(), `${tool.name} takes ${prop}`).not.toContain("account");
      }
    }
  });
});

describe("PLANT 3: the redaction default (370)", () => {
  it("THE FOUR PII TOOLS RETURN NO NAME AND NO RAW EMAIL, over the response bytes", async () => {
    const { tokens } = await seed();
    for (const [name, args] of [
      ["foxhound_list_customers", {}],
      ["foxhound_get_customer", { stripe_customer_id: `cus_${MINE}` }],
      ["foxhound_list_payments", {}],
      ["foxhound_get_payment", { payment_id: `fp_${MINE}` }],
    ] as const) {
      const answer = await callTool(tokens[MINE], name, args);
      expect(toolOutput(answer).isError, `${name} errored: ${answer.text}`).toBe(false);
      const { text } = answer;
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
    for (const name of ["foxhound_list_customers", "foxhound_list_payments"]) {
      const { text } = await callTool(tokens[MINE], name);
      expect(text, name).toContain("z***@example.test");
    }
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

  it("the redactor nulls the name and never merely omits it", () => {
    const out = redactToolResult({
      stripeCustomerId: "cus_1",
      customerName: "Real Name",
      customerEmail: "real@example.test",
      mrrContributionCents: 100,
    }) as Record<string, unknown>;
    expect(out.customerName).toBeNull();
    expect("customerName" in out).toBe(true);
    expect(out.customerEmail).toBe("r***@example.test");
    // Everything else passes through untouched.
    expect(out.mrrContributionCents).toBe(100);
    expect(out.stripeCustomerId).toBe("cus_1");

    // A shape that carries an email and no name at all: the walk redacts what
    // is there rather than requiring both.
    const payment = redactToolResult({
      stripeCustomerId: "cus_1",
      customerEmail: "real@example.test",
      amountCents: 500,
    }) as Record<string, unknown>;
    expect(payment.customerEmail).toBe("r***@example.test");
    expect(payment.amountCents).toBe(500);
    expect("customerName" in payment).toBe(false);
  });

  it("ONE IMPLEMENTATION: no tool masks inline, because no tool redacts at all", () => {
    // A second masker in the tools file would be a second authority for one
    // rule, and the boundary plant below would stay green while this file
    // quietly held the property up (381 binding e).
    const tools = code(read("app/lib/mcp/tools.server.ts"));
    expect(tools).not.toContain("lastIndexOf(\"@\")");
    expect(tools).not.toContain("***");
    expect(tools).not.toContain("redact");
    // And the authority is where it is claimed to be.
    expect(code(read("app/lib/mcp/registry.ts"))).toContain("redactToolResult");
  });
});

describe("PLANT 4: failures are tool errors, not transport throws", () => {
  it("a missing required argument comes back as a tool error the agent can fix", async () => {
    const { tokens } = await seed();
    const answer = await callTool(tokens[MINE], "foxhound_get_customer", {});
    // 200 with isError, not a JSON-RPC error: MCP reserves protocol errors for
    // protocol failures, and this is the caller's argument mistake. The SDK's
    // schema validator may answer before the executor does, so the sentence is
    // read from the content text, which both paths fill.
    expect(answer.status).toBe(200);
    const result = (answer.json as { result: { isError?: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text).join(" ")).toContain("stripe_customer_id");
  });

  it("an unknown tool is still a PROTOCOL error, which is the other side of the line", async () => {
    const { tokens } = await seed();
    const { json } = await callTool(tokens[MINE], "foxhound_no_such_tool");
    const error = (json as { error?: { code: number; message: string } }).error;
    expect(error?.code).toBe(-32602);
    expect(error?.message).toContain("foxhound_no_such_tool");
    expect((json as { result?: unknown }).result).toBeUndefined();
  });

  it("a refused id does not take the transport down", async () => {
    // An audit run id that does not exist is a tool error carrying a sentence
    // (the old tool answered { run: null }); the point is that the transport
    // stayed 200 and the agent was told how to recover.
    const { tokens } = await seed();
    const answer = await callTool(tokens[MINE], "foxhound_review_audits", { run_id: "nope" });
    expect(answer.status).toBe(200);
    const { isError, data } = toolOutput(answer);
    expect(isError).toBe(true);
    expect(data.tool).toBe("foxhound_review_audits");
    expect(String(data.error)).toContain("nope");
  });
});

describe("PLANT 5: pagination is one shape, and a cursor belongs to its tool", () => {
  it("foxhound_list_payments walks every page with page_size 10, and the last says so", async () => {
    // 1 seeded + 22 extra = 23 payments on MINE: pages of 10, 10 and 3. THEIRS
    // holds one more, which must appear on no page.
    const { tokens } = await seed(22);
    const seen: string[] = [];
    let cursor: string | null = null;
    const pages: { count: number; has_more: unknown; next_cursor: unknown }[] = [];
    for (let guard = 0; guard < 5; guard++) {
      const args: Record<string, unknown> = { page_size: 10 };
      if (cursor) args.cursor = cursor;
      const answer = await callTool(tokens[MINE], "foxhound_list_payments", args);
      const { isError, data } = toolOutput(answer);
      expect(isError, answer.text).toBe(false);
      expect(answer.text).not.toContain(THEIRS);
      const payments = data.payments as { id: string }[];
      expect(data.total).toBe(23);
      pages.push({ count: payments.length, has_more: data.has_more, next_cursor: data.next_cursor });
      seen.push(...payments.map((p) => p.id));
      if (data.has_more !== true) break;
      expect(typeof data.next_cursor).toBe("string");
      cursor = data.next_cursor as string;
    }
    expect(pages.map((p) => p.count)).toEqual([10, 10, 3]);
    expect(pages.map((p) => p.has_more)).toEqual([true, true, false]);
    // The last page says it is the last in both fields, null rather than absent.
    expect(pages[2].next_cursor).toBeNull();
    // Every page is new rows: the cursor really read on, rather than returning
    // the first page again with has_more true.
    expect(new Set(seen).size).toBe(23);
    expect(seen).toContain(`fp_${MINE}`);
  });

  it("a cursor from one tool is refused by another, with isError rather than a wrong page", async () => {
    // STACKED-GUARD: the disputes list on this fixture is EMPTY, so page 2 of it
    // read as a page number would come back as an empty, valid answer. Only the
    // tool check in the cursor can make it an error.
    const { tokens } = await seed(22);
    const first = toolOutput(await callTool(tokens[MINE], "foxhound_list_payments", { page_size: 10 }));
    const foreign = first.data.next_cursor as string;
    expect(typeof foreign).toBe("string");
    for (const name of ["foxhound_list_disputes", "foxhound_list_customers", "foxhound_review_audits"]) {
      const answer = await callTool(tokens[MINE], name, { cursor: foreign });
      expect(answer.status, name).toBe(200);
      const { isError, data } = toolOutput(answer);
      expect(isError, `${name} accepted another tool's cursor`).toBe(true);
      expect(String(data.error), name).toContain(name);
    }
    // And the disputes list's own first page answers cleanly, so the refusal
    // above is the cursor and not a broken tool.
    const own = toolOutput(await callTool(tokens[MINE], "foxhound_list_disputes"));
    expect(own.isError).toBe(false);
    expect(own.data.has_more).toBe(false);
    expect(own.data.next_cursor).toBeNull();
    // A cursor that is not one of ours at all is refused the same way.
    const junk = toolOutput(await callTool(tokens[MINE], "foxhound_list_payments", { cursor: "not-a-cursor" }));
    expect(junk.isError).toBe(true);
  });
});

describe("PLANT 6: the end to end, through the real transport", () => {
  it("initialize, tools/list, then three tools/call round-trips on one key", async () => {
    const { tokens } = await seed();

    const init = await call(tokens[MINE], "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "foxhound-test", version: "1.0.0" },
    });
    expect(init.status).toBe(200);
    expect((init.json as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");

    const list = await call(tokens[MINE], "tools/list");
    expect((list.json as { result: { tools: unknown[] } }).result.tools).toHaveLength(12);

    for (const [name, args] of [
      ["foxhound_review_audits", {}],
      ["foxhound_list_customers", {}],
      ["foxhound_list_payments", {}],
    ] as const) {
      const answer = await callTool(tokens[MINE], name, args);
      expect(answer.status, name).toBe(200);
      const result = (answer.json as { result: { isError?: boolean; structuredContent: unknown } }).result;
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

  it("the modern era serves the twelve tools in a JSON body", async () => {
    const { tokens } = await seed();
    const answer = await call(tokens[MINE], "tools/list", {}, { era: "modern" });
    expect(answer.status).toBe(200);
    expect(answer.res.headers.get("content-type")).toContain("application/json");
    const tools = (answer.json as { result: { tools: ListedTool[] } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...MERCHANT_TOOL_NAMES].sort());
    // A modern tools/call reaches a tool too, not only the list.
    const called = await call(
      tokens[MINE],
      "tools/call",
      { name: "foxhound_list_customers", arguments: {} },
      { era: "modern" },
    );
    expect(toolOutput(called).isError).toBe(false);
    expect(called.text).toContain(`cus_${MINE}`);
    expect(MODERN_VERSION).toBe("2026-07-28");
  });
});

describe("PLANT 7: the tool module holds no money writer", () => {
  it("no money path, no outcome, no dispute or key writer, no raw write, in the tool module", () => {
    // MOVED IN SESSION 79 and kept through the regroup: the module does write,
    // but only through the settings forms' own `applyX` functions. What it must
    // never reach is money, an outcome, a dispute submission, a key, or a raw
    // insert/update/delete that bypasses those forms and their trace.
    const tools = code(read("app/lib/mcp/tools.server.ts"));
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
    // The only writer module it imports is the settings apply module, so a
    // writer cannot arrive under a name this list has not thought of yet.
    const imports = [...tools.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const path of imports) {
      expect(path, `${path} is not a read or the settings apply module`).toMatch(
        /(queries\.server|views\.server|directory\.server|trends\.server|persist\.server|preview\.server|audit-settings\.server|\/render|settings\/apply\.server|\.\/registry)$/,
      );
    }
    // persist.server holds a writer too (saveAuditRun, above); only its two
    // readers are taken from it.
    expect(tools).toMatch(/import \{ getAuditRun, listAuditRuns \} from "~\/lib\/audit\/persist\.server"/);
  });
});

describe("PLANT 8: the copy release, and every earlier state gone", () => {
  const flatten = (guide: (typeof DOC_GUIDES)[number]) =>
    JSON.stringify(guide.sections);

  const platform = flatten(DOC_GUIDES.find((g) => g.slug === "platform")!);
  const s29 = read("app/routes/app/settings/api-keys.tsx");
  const llms = read("app/routes/files/llms.ts");

  it("S29 describes a live endpoint, the settings it changes, and the redaction default", () => {
    // MOVED IN SESSION 79. "read-only" and "cannot change anything" were true of
    // the thirteen and became false the moment four write tools shipped; a copy
    // carrier that kept them would be understating what a key grants, which is
    // the same defect as overstating it.
    expect(s29).toContain("/mcp");
    // SESSION 80 moved it to eight writes; the regroup folded those eight into
    // two tools, and the page now names what a key can change rather than a
    // tool count. Both earlier counts are asserted ABSENT, not merely
    // superseded: a page that still said four would understate what a key
    // grants, and one that still said eight would describe tools that are gone.
    expect(s29).toContain("and change your settings: audit,");
    expect(s29).not.toContain("change four settings");
    expect(s29).not.toContain("change eight settings");
    expect(s29).toContain("brand voice");
    expect(s29).toContain("switch off and delete");
    // The omission rule is stated where it is true and only there: brand voice
    // and business context keep an omitted field, notifications do not.
    expect(s29.replace(/\s+/g, " ")).toContain(
      "Leaving a field out of the brand voice or business context leaves it as it is.",
    );
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
    // The count is the regroup's two, and both earlier counts are ABSENT.
    expect(platform).toContain("Two tools WRITE, and they change settings only:");
    expect(platform).not.toContain("Eight tools WRITE");
    expect(platform).not.toContain("Four tools WRITE");
    // The omitted-versus-empty rule is a thing an agent has to be told, because
    // guessing it wrong in one direction erases a merchant's settings. It is
    // told per section, because notifications are replaced whole: the old
    // blanket sentence would have been wrong for them.
    expect(platform).toContain(
      "Leaving a field out of the brand voice or the business context leaves it as it is and only an empty value clears one; the notification settings are replaced as a whole, so an agent sends all of them.",
    );
    expect(platform).not.toContain("Leaving a field out of a write leaves it as it is");
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
    expect(llms).toContain("Two tools write, and only to settings:");
    expect(llms).not.toContain("Eight tools write, and only to settings");
    expect(llms).not.toContain("Four tools write, and only to settings");
    expect(llms).toContain(
      "A field left out of the brand voice or the merchant context is left as it is and only an empty value clears one; the notification settings are replaced as a whole.",
    );
    expect(llms).not.toContain("A field left out of a write is left as it is");
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
