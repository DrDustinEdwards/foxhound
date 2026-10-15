// The admin MCP servers page's words: pure helpers (not a .server module, the
// page renders them), tested without a database. Plain sentence-case words
// for the stored codes (Dustin's review, 2026-10-11).

import { MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";

export const MCPS_PATH = "/admin/mcps";

/** A key's scope as the page says it. An unknown code is shown as stored, so
 *  a scope added later is never hidden behind a wrong word. */
export function scopeWords(scope: string): string {
  if (scope === MCP_TOKEN_SCOPE.MERCHANT) return "Merchant";
  if (scope === MCP_TOKEN_SCOPE.ADMIN) return "Admin API";
  return scope;
}

/** A logged call's outcome (app/lib/mcp/call-log.server.ts) in a word. */
export function outcomeWords(outcome: string): string {
  if (outcome === "ok") return "Worked";
  if (outcome === "tool_error") return "Refused";
  if (outcome === "protocol_error") return "Failed";
  return outcome;
}
