import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, customerContext, failedPayments } from "~/db/schema";
import { MCP_TOKEN_PREFIX, MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { maskEmail } from "~/lib/mcp/redact";

import { createInMemoryDb } from "./helpers/inmemory-db";
import { mcpRequest, readMcp, toolOutput, type McpCallInit } from "./helpers/mcp-client";

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
const { MERCHANT_TOOLS } = await import(
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


describe("PLANT 3: the redaction default (370)", () => {

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
