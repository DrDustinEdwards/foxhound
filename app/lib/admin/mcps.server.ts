// /admin/mcps data layer: the api_keys table, the merchant MCP call log
// (mcp_calls) and the merchant tool registry. READ only.
//
// KEY MATERIAL NEVER LEAVES THIS MODULE BECAUSE IT IS NEVER READ: every select
// names its columns, and the hash column is not one of them. A key has no
// stored prefix, so the label is what identifies it.
//
// A CALL'S ARGUMENTS ARE NOT READ EITHER. They are what an agent asked about a
// merchant's customers; the tool name, the outcome and the masked error say
// what happened without copying them onto an admin page.

import { and, count, desc, eq, gte, isNull, ne } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, apiKeys, mcpCalls } from "~/db";
import { MCP_CALLS_SHOWN, maskSecretsInText } from "~/lib/admin/mcps";
import { MERCHANT_TOOLS } from "~/lib/mcp/tools.server";
import { DAY_MS } from "~/lib/constants";

export interface AdminApiKeyRow {
  id: string;
  label: string | null;
  scope: string;
  accountId: string | null;
  accountName: string | null;
  createdAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** Every key on the platform, merchant and admin, live and revoked, newest
 *  first (Recova's order). */
export async function listAdminApiKeys(db: Db): Promise<AdminApiKeyRow[]> {
  return db
    .select({
      id: apiKeys.id,
      label: apiKeys.label,
      scope: apiKeys.scope,
      accountId: apiKeys.accountId,
      accountName: accounts.name,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .leftJoin(accounts, eq(accounts.id, apiKeys.accountId))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
}

export interface AdminMcpCallRow {
  id: string;
  tool: string;
  outcome: string;
  error: string | null;
  accountId: string;
  accountName: string | null;
  apiKeyId: string;
  /** False when the key is no longer in api_keys: the log's api_key_id is a
   *  soft reference that outlives the key. */
  keyFound: boolean;
  keyLabel: string | null;
  createdAt: Date;
}

/** The newest merchant MCP calls, every account, with the error text masked
 *  for display (maskSecretsInText) so the raw text never reaches the page. */
export async function listRecentMcpCalls(db: Db, limit = MCP_CALLS_SHOWN): Promise<AdminMcpCallRow[]> {
  return db
    .select({
      id: mcpCalls.id,
      tool: mcpCalls.tool,
      outcome: mcpCalls.outcome,
      error: mcpCalls.error,
      accountId: mcpCalls.accountId,
      accountName: accounts.name,
      apiKeyId: mcpCalls.apiKeyId,
      foundKeyId: apiKeys.id,
      keyLabel: apiKeys.label,
      createdAt: mcpCalls.createdAt,
    })
    .from(mcpCalls)
    .leftJoin(accounts, eq(accounts.id, mcpCalls.accountId))
    .leftJoin(apiKeys, eq(apiKeys.id, mcpCalls.apiKeyId))
    .orderBy(desc(mcpCalls.createdAt), desc(mcpCalls.id))
    .limit(limit)
    .then((rows) => rows.map(({ foundKeyId, ...row }) => ({
      ...row,
      error: row.error === null ? null : maskSecretsInText(row.error),
      keyFound: foundKeyId !== null,
    })));
}

export interface McpSummary {
  keysTotal: number;
  keysActive: number;
  callsLast24h: number;
  failedLast24h: number;
}

export async function getMcpSummary(db: Db, now = new Date()): Promise<McpSummary> {
  const since = new Date(now.getTime() - DAY_MS);
  const [total, active, calls, failed] = await Promise.all([
    db.select({ n: count() }).from(apiKeys),
    db.select({ n: count() }).from(apiKeys).where(isNull(apiKeys.revokedAt)),
    db.select({ n: count() }).from(mcpCalls).where(gte(mcpCalls.createdAt, since)),
    db
      .select({ n: count() })
      .from(mcpCalls)
      .where(and(gte(mcpCalls.createdAt, since), ne(mcpCalls.outcome, "ok"))),
  ]);
  return {
    keysTotal: total[0]?.n ?? 0,
    keysActive: active[0]?.n ?? 0,
    callsLast24h: calls[0]?.n ?? 0,
    failedLast24h: failed[0]?.n ?? 0,
  };
}

export interface MerchantToolRow {
  name: string;
  title: string;
  /** False when the tool says it only reads (its readOnlyHint). */
  writes: boolean;
}

/** The merchant MCP's tools as the live registry lists them, so the page can
 *  never name a tool that does not exist or miss one that does. */
export function merchantToolCoverage(): MerchantToolRow[] {
  return MERCHANT_TOOLS.list().map((t) => ({ name: t.name, title: t.title, writes: !t.annotations.readOnlyHint }));
}

/** Everything /admin/operations shows about the MCP servers. */
export async function loadMcpOverview(db: Db) {
  const [summary, keys, calls] = await Promise.all([getMcpSummary(db), listAdminApiKeys(db), listRecentMcpCalls(db)]);
  return { summary, keys, calls, tools: merchantToolCoverage() };
}
