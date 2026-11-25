import { beforeEach, describe, expect, it, vi } from "vitest";

import { accounts, apiKeys, mcpCalls } from "~/db";
import { maskSecretsInText } from "~/lib/admin/mcps";
import { listRecentMcpCalls, loadMcpOverview } from "~/lib/admin/mcps.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

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
    {
      id: "key_a",
      accountId: "acct_north",
      keyHash: SECRET_HASH,
      label: "Claude desktop",
      scope: "mcp_merchant",
      createdAt: new Date(NOW - 3 * DAY),
      lastUsedAt: new Date(NOW - HOUR),
    },
    {
      id: "key_b",
      accountId: "acct_quiet",
      keyHash: `${SECRET_HASH}b`,
      label: null,
      scope: "mcp_merchant",
      createdAt: new Date(NOW - 2 * DAY),
      lastUsedAt: null,
    },
    {
      id: "key_c",
      accountId: null,
      keyHash: `${SECRET_HASH}c`,
      label: "Admin MCP",
      scope: "mcp_admin",
      createdAt: new Date(NOW - DAY),
      lastUsedAt: null,
    },
    {
      id: "key_d",
      accountId: "acct_north",
      keyHash: `${SECRET_HASH}d`,
      label: "Old laptop",
      scope: "mcp_merchant",
      createdAt: new Date(NOW - 10 * DAY),
      lastUsedAt: null,
      revokedAt: new Date(NOW - 5 * DAY),
    },
  ]);
  await db.insert(mcpCalls).values([
    {
      id: "call_1",
      accountId: "acct_north",
      apiKeyId: "key_a",
      tool: "foxhound_list_recoveries",
      arguments: { limit: 5 },
      outcome: "ok",
      error: null,
      createdAt: new Date(NOW - 10 * MIN),
    },
    {
      id: "call_2",
      accountId: "acct_north",
      apiKeyId: "key_a",
      tool: "foxhound_get_nothing",
      arguments: {},
      outcome: "protocol_error",
      error: "Tool not found",
      createdAt: new Date(NOW - 20 * MIN),
    },
    {
      id: "call_3",
      accountId: "acct_quiet",
      apiKeyId: "key_gone",
      tool: "foxhound_update_settings",
      arguments: { slack_webhook_url: "[redacted]" },
      outcome: "tool_error",
      error: "Bad input for j***@example.com",
      createdAt: new Date(NOW - 2 * DAY),
    },
  ]);
  return db;
}

describe("the data layer", () => {
  it("lists the newest calls with the key's label and the account's name, and no arguments", async () => {
    const calls = (await listRecentMcpCalls(await seed())) as unknown as Record<string, unknown>[];
    expect(calls.map((c) => c.id)).toEqual(["call_1", "call_2", "call_3"]);
    expect(calls[0]).toMatchObject({ keyLabel: "Claude desktop", accountName: "North Coffee" });
    expect(calls[2]).toMatchObject({
      keyFound: false,
      keyLabel: null,
      accountId: "acct_quiet",
      error: "Bad input for j***@example.com",
    });
    for (const c of calls) expect(Object.keys(c)).not.toContain("arguments");
  });
});

// Error text can echo an agent's input, so the page masks credentials and addresses in it.
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
    const mask = maskSecretsInText;
    for (const hostile of HOSTILE) {
      const out = mask(hostile);
      expect(out, hostile).not.toMatch(/SECRET/);
      expect(out, hostile).not.toMatch(/alice|BOB%40|carol@/i);
    }
    expect(mask("Bad key fox_mcp_AbCdEf0123456789xyzSECRET in header")).toBe(
      "Bad key fox_mcp_[redacted] in header",
    );
    expect(mask("Stripe said sk_live_51HabcDEF123SECRET")).toBe("Stripe said sk_live_[redacted]");
    expect(mask("No customer alice%40example.com")).toBe("No customer a***%40example.com");
    expect(mask("Nothing to hide here: limit must be 1 to 50")).toBe(
      "Nothing to hide here: limit must be 1 to 50",
    );
  });
});

describe("the loader", () => {
  beforeEach(async () => {
    harness.db = await seed();
  });

  it("returns the summary, the keys, the calls and the tools", async () => {
    const data = (await loadMcpOverview(harness.db as never)) as unknown as Record<string, unknown>;
    expect(data.summary).toEqual({
      keysTotal: 4,
      keysActive: 3,
      callsLast24h: 2,
      failedLast24h: 1,
    });
    expect(JSON.stringify(data)).not.toContain(SECRET_HASH);
  });
});
