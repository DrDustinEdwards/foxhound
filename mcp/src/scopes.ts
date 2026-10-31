import { mcpScopes } from "@dustinedwards/site-runtime/mcp-server";

// Least scope first (MCP ruling rule 12.3). Every grant can read; a grant can
// pause and stage only when the person allows changes on the consent page
// (site-runtime's mcp-login decides the grant).
//
// ONE NAMING SCHEME (area 11, A12): site-runtime's mcpScopes, as on every
// family MCP server, so foxhound.read and foxhound.write. Grants made before
// the rename hold foxhound_admin:read and foxhound_admin:write, stored in
// OAUTH_KV; currentScopes reads those as the new names, so a grant already
// connected keeps working until it is renewed.

const SCOPES = mcpScopes("foxhound");
export const SCOPE_READ = SCOPES.read;
export const SCOPE_WRITE = SCOPES.write;
export const SCOPES_SUPPORTED: string[] = [...SCOPES.all];

const RENAMED: Record<string, string> = {
  "foxhound_admin:read": SCOPE_READ,
  "foxhound_admin:write": SCOPE_WRITE,
};

/** A grant's scopes under the current names, a grant from before the rename included. */
export function currentScopes(held: readonly string[]): string[] {
  return [...new Set(held.map((scope) => RENAMED[scope] ?? scope))];
}
