import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, mcpCalls } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J49 (job_4f27c866fb97, row D15): /admin/mcps on the family admin pattern
// (Capsomer patterns, Dustin's Q9 of 2026-10-14) and his 2026-10-11 admin
// review. Recova's page (app/admin/mcps/page.tsx, blob d0381e5f) is the
// inventory: the API keys table (label, scope, account, status, created, last
// used, with a total and an active count) and the tool coverage. Its static
// claims about its own server and its hand-written list of workspace
// connectors are not copied (ruling 406 binding 6): the tools come from
// Foxhound's live registry, and the merchant MCP call log is added.
// The api_keys table holds key material: the page never reads key_hash.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// Looked up so a missing module fails the assertion that names it, not the
// whole file (RULES.md 6.5).
const route: Record<string, unknown> = await import("~/routes/admin/mcps").catch(() => ({}));
const serverLib: Record<string, unknown> = await import("~/lib/admin/mcps.server").catch(() => ({}));
const pageLib: Record<string, unknown> = await import("~/lib/admin/mcps").catch(() => ({}));

const NOW = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SECRET_HASH = "4f1c0ffee5ecret5ha256hash0000000000000000000000000000000000000000";

async function seed() {
  const { db } = createInMemoryDb();
  await db.insert(accounts).values([
    { id: "acct_north", name: "North Coffee" },
    { id: "acct_quiet", name: null },
  ]);
  await db.insert(apiKeys).values([
    { id: "key_a", accountId: "acct_north", keyHash: SECRET_HASH, label: "Claude desktop", scope: "mcp_merchant", createdAt: new Date(NOW - 3 * DAY), lastUsedAt: new Date(NOW - HOUR) },
    { id: "key_b", accountId: "acct_quiet", keyHash: `${SECRET_HASH}b`, label: null, scope: "mcp_merchant", createdAt: new Date(NOW - 2 * DAY), lastUsedAt: null },
    { id: "key_c", accountId: null, keyHash: `${SECRET_HASH}c`, label: "Admin MCP", scope: "mcp_admin", createdAt: new Date(NOW - DAY), lastUsedAt: null },
    { id: "key_d", accountId: "acct_north", keyHash: `${SECRET_HASH}d`, label: "Old laptop", scope: "mcp_merchant", createdAt: new Date(NOW - 10 * DAY), lastUsedAt: null, revokedAt: new Date(NOW - 5 * DAY) },
  ]);
  await db.insert(mcpCalls).values([
    { id: "call_1", accountId: "acct_north", apiKeyId: "key_a", tool: "foxhound_list_recoveries", arguments: { limit: 5 }, outcome: "ok", error: null, createdAt: new Date(NOW - 10 * MIN) },
    { id: "call_2", accountId: "acct_north", apiKeyId: "key_a", tool: "foxhound_get_nothing", arguments: {}, outcome: "protocol_error", error: "Tool not found", createdAt: new Date(NOW - 20 * MIN) },
    { id: "call_3", accountId: "acct_quiet", apiKeyId: "key_gone", tool: "foxhound_update_settings", arguments: { slack_webhook_url: "[redacted]" }, outcome: "tool_error", error: "Bad input for j***@example.com", createdAt: new Date(NOW - 2 * DAY) },
  ]);
  return db;
}

interface KeyRow {
  id: string;
  label: string | null;
  scope: string;
  accountId: string | null;
  accountName: string | null;
  createdAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

describe("the data layer", () => {
  it("lists every key newest first with safe metadata only, never the hash", async () => {
    expect(typeof serverLib.listAdminApiKeys).toBe("function");
    const db = await seed();
    const keys = (await (serverLib.listAdminApiKeys as (db: unknown) => Promise<KeyRow[]>)(db));
    expect(keys.map((k) => k.id)).toEqual(["key_c", "key_b", "key_a", "key_d"]);
    expect(keys[2]).toMatchObject({ label: "Claude desktop", scope: "mcp_merchant", accountId: "acct_north", accountName: "North Coffee" });
    expect(keys[0]).toMatchObject({ scope: "mcp_admin", accountId: null, accountName: null });
    expect(keys[3].revokedAt).toBeInstanceOf(Date);
    for (const k of keys) {
      expect(Object.keys(k)).not.toContain("keyHash");
      expect(JSON.stringify(k)).not.toContain(SECRET_HASH);
    }
  });

  it("lists the newest calls with the key's label and the account's name, and no arguments", async () => {
    expect(typeof serverLib.listRecentMcpCalls).toBe("function");
    const db = await seed();
    const calls = (await (serverLib.listRecentMcpCalls as (db: unknown) => Promise<Record<string, unknown>[]>)(db));
    expect(calls.map((c) => c.id)).toEqual(["call_1", "call_2", "call_3"]);
    expect(calls[0]).toMatchObject({ tool: "foxhound_list_recoveries", outcome: "ok", keyLabel: "Claude desktop", accountName: "North Coffee" });
    expect(calls[0].keyFound).toBe(true);
    expect(calls[2]).toMatchObject({ keyFound: false, keyLabel: null, accountId: "acct_quiet", error: "Bad input for j***@example.com" });
    for (const c of calls) expect(Object.keys(c)).not.toContain("arguments");
  });

  it("counts keys, active keys, and the calls and failed calls of the last day", async () => {
    expect(typeof serverLib.getMcpSummary).toBe("function");
    const db = await seed();
    expect(await (serverLib.getMcpSummary as (db: unknown) => Promise<unknown>)(db)).toEqual({
      keysTotal: 4,
      keysActive: 3,
      callsLast24h: 2,
      failedLast24h: 1,
    });
  });

  it("reads the merchant tools from the live registry, read or write by its hints", async () => {
    expect(typeof serverLib.merchantToolCoverage).toBe("function");
    const tools = (serverLib.merchantToolCoverage as () => Array<{ name: string; title: string; writes: boolean }>)();
    const { MERCHANT_TOOL_NAMES, MERCHANT_WRITE_TOOL_NAMES } = await import("~/lib/mcp/tools.server");
    expect(tools.map((t) => t.name).sort()).toEqual([...MERCHANT_TOOL_NAMES].sort());
    expect(tools.filter((t) => t.writes).map((t) => t.name).sort()).toEqual([...MERCHANT_WRITE_TOOL_NAMES].sort());
  });

  it("never selects key_hash", () => {
    const src = readFileSync("app/lib/admin/mcps.server.ts", "utf8");
    expect(src).toMatch(/apiKeys/);
    expect(src).not.toMatch(/keyHash|key_hash/);
  });
});

// Review of PR #96 (CHANGES): the error text an agent was given can echo its
// own input, so the page masks credentials and encoded addresses in it as well
// as the plain addresses the log already masked.
const HOSTILE = [
  "Bad key fox_mcp_AbCdEf0123456789xyzSECRET in header",
  "Stripe said sk_live_51HabcDEF123SECRET and sk_test_4eC39HqLyjWDarjtT1zdp7dcSECRET",
  "restricted rk_live_9xYzSECRET1234 / rk_test_AbcSECRET5678",
  "post to https://hooks.slack.com/services/T0000/B0000/XXXXSECRETXXXX failed",
  "and https://discord.com/api/webhooks/1234567890/abcDEF-SECRET_token too",
  "or https://discordapp.com/api/webhooks/42/oldSECRETtoken",
  "No customer alice%40example.com or BOB%40Example.COM",
  "No customer carol@example.com",
];

describe("the error text is masked for display", () => {
  it("masks tokens, Stripe keys, webhook URLs and plain or encoded addresses", () => {
    expect(typeof pageLib.maskSecretsInText).toBe("function");
    const mask = pageLib.maskSecretsInText as (t: string) => string;
    for (const hostile of HOSTILE) {
      const out = mask(hostile);
      expect(out, hostile).not.toMatch(/SECRET/);
      expect(out, hostile).not.toMatch(/alice|BOB%40|carol@/i);
    }
    expect(mask("Bad key fox_mcp_AbCdEf0123456789xyzSECRET in header")).toBe("Bad key fox_mcp_[redacted] in header");
    expect(mask("Stripe said sk_live_51HabcDEF123SECRET")).toBe("Stripe said sk_live_[redacted]");
    expect(mask("No customer alice%40example.com")).toBe("No customer a***%40example.com");
    expect(mask("Nothing to hide here: limit must be 1 to 50")).toBe("Nothing to hide here: limit must be 1 to 50");
  });

  it("masks in the data layer, so the raw text never reaches the browser", async () => {
    const db = await seed();
    await db.insert(mcpCalls).values({
      id: "call_9",
      accountId: "acct_north",
      apiKeyId: "key_a",
      tool: "foxhound_update_settings",
      arguments: {},
      outcome: "tool_error",
      error: HOSTILE.join(" | "),
      createdAt: new Date(NOW),
    });
    const calls = await (serverLib.listRecentMcpCalls as (db: unknown) => Promise<Array<{ id: string; error: string | null }>>)(db);
    const err = calls.find((c) => c.id === "call_9")?.error ?? "";
    expect(err).toContain("[redacted]");
    expect(err).not.toMatch(/SECRET|alice|carol@/);
  });

  it("masks on the page too", () => {
    const html = render({ calls: [call(1, { outcome: "tool_error", error: HOSTILE.join(" | ") })] });
    expect(html).not.toMatch(/SECRET|alice|carol@/);
  });
});

describe("the loader", () => {
  beforeEach(async () => {
    harness.db = await seed();
  });

  it("returns the summary, the keys, the calls and the tools", async () => {
    expect(typeof route.loader).toBe("function");
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext, nonce: "" });
    const data = await (route.loader as (a: unknown) => Promise<Record<string, unknown>>)({
      request: new Request("https://foxhoundapp.com/admin/mcps"),
      context,
      params: {},
    });
    expect(data.summary).toEqual({ keysTotal: 4, keysActive: 3, callsLast24h: 2, failedLast24h: 1 });
    expect((data.keys as unknown[]).length).toBe(4);
    expect((data.calls as unknown[]).length).toBe(3);
    expect((data.tools as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain(SECRET_HASH);
  });
});

// ---------------------------------------------------------------- the page

function key(over: Partial<KeyRow> = {}): KeyRow {
  return {
    id: "key_a",
    label: "Claude desktop",
    scope: "mcp_merchant",
    accountId: "acct_north",
    accountName: "North Coffee",
    createdAt: new Date(NOW - DAY),
    lastUsedAt: new Date(NOW - HOUR),
    revokedAt: null,
    ...over,
  };
}

function call(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `call_${i}`,
    tool: "foxhound_list_recoveries",
    outcome: "ok",
    error: null,
    accountId: "acct_north",
    accountName: "North Coffee",
    apiKeyId: "key_a",
    keyFound: true,
    keyLabel: "Claude desktop",
    createdAt: new Date(NOW - i * MIN),
    ...over,
  };
}

function render(over: { keys?: KeyRow[]; calls?: unknown[]; tools?: unknown[] } = {}) {
  const data = {
    summary: { keysTotal: 4, keysActive: 3, callsLast24h: 12, failedLast24h: 2 },
    keys: over.keys ?? [
      key(),
      key({ id: "key_b", label: null, accountId: "acct_quiet", accountName: null, lastUsedAt: null }),
      key({ id: "key_c", label: "Admin MCP", scope: "mcp_admin", accountId: null, accountName: null }),
      key({ id: "key_d", label: "Old laptop", revokedAt: new Date(NOW - DAY) }),
    ],
    calls: over.calls ?? [call(1), call(2, { outcome: "tool_error", error: "Bad input", keyLabel: null, keyFound: false })],
    tools: over.tools ?? [
      { name: "foxhound_list_recoveries", title: "List recoveries", writes: false },
      { name: "foxhound_update_settings", title: "Update settings", writes: true },
    ],
  };
  const Page = route.default as (props: unknown) => React.ReactNode;
  expect(typeof Page).toBe("function");
  const Stub = createRoutesStub([{ path: "/admin/mcps", Component: () => createElement(Page as never, { loaderData: data } as never) }]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/admin/mcps"] }));
}


describe("the MCP servers page", () => {

  it("never renders key material", () => {
    const html = render({ keys: [{ ...key(), keyHash: SECRET_HASH } as KeyRow] });
    expect(html).not.toContain(SECRET_HASH);
  });
});
