import { mcpScopes } from "@dustinedwards/site-runtime/mcp-server";

// Least scope first. Every grant can read; a grant can pause and stage only when the person allows changes on the consent page (site-runtime's mcp-login decides the grant). Naming is site-runtime's mcpScopes, as on every network MCP server.

const SCOPES = mcpScopes("foxhound");
export const SCOPE_READ = SCOPES.read;
export const SCOPE_WRITE = SCOPES.write;
