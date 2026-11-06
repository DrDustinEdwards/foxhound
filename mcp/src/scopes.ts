import { mcpScopes } from "@dustinedwards/site-runtime/mcp-server";

// Least scope first (MCP ruling rule 12.3). Every grant can read; a grant can
// pause and stage only when the person allows changes on the consent page
// (site-runtime's mcp-login decides the grant). One naming scheme (area 11,
// A12): site-runtime's mcpScopes, as on every network MCP server.

const SCOPES = mcpScopes("foxhound");
export const SCOPE_READ = SCOPES.read;
export const SCOPE_WRITE = SCOPES.write;
