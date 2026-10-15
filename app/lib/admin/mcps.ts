// The admin MCP servers page's words: pure helpers (not a .server module, the
// page renders them), tested without a database. Plain sentence-case words
// for the stored codes (Dustin's review, 2026-10-11).

import { MCP_TOKEN_SCOPE } from "~/lib/auth/mcp-tokens";
import { maskEmailsInText } from "~/lib/mcp/redact";

export const MCPS_PATH = "/admin/mcps";

/** How many of the newest calls the page lists. Here, not in the .server
 *  module, because the page's own text names it. */
export const MCP_CALLS_SHOWN = 50;

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

// What the page hides in a call's error text. The log already masks plain
// addresses (app/lib/mcp/call-log.server.ts), but an error can echo whatever
// the agent sent, so this page also hides credentials and URL-encoded
// addresses before showing it. A display mask: the stored row is untouched.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Foxhound MCP keys (app/lib/auth/mcp-tokens.ts MCP_TOKEN_PREFIX).
  [/\bfox_mcp_[A-Za-z0-9_-]+/g, "fox_mcp_[redacted]"],
  // Stripe secret and restricted keys, live and test.
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]+/g, "$1_$2_[redacted]"],
  // Slack and Discord webhook URLs: the path is the credential.
  [/https?:\/\/hooks\.slack\.com\/[^\s"'<>]+/gi, "https://hooks.slack.com/[redacted]"],
  [/https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi, "https://discord.com/api/webhooks/[redacted]"],
];

// An address written with %40 for the @, as it appears in a query string.
const ENCODED_EMAIL = /([^\s@%'"<>(),;:/?&=]+)%40([^\s@'"<>(),;:/?&=]+\.[^\s@'"<>(),;:/?&=]+)/gi;

export function maskSecretsInText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(ENCODED_EMAIL, (_match, local: string, domain: string) => `${local.charAt(0)}***%40${domain}`);
  return maskEmailsInText(out);
}
