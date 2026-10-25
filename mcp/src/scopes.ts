// Least scope first (MCP ruling rule 12.3). Every grant can read; a grant can
// pause and stage only when the person allows changes on the consent page
// (site-runtime's mcp-login decides the grant).

export const SCOPE_READ = "foxhound_admin:read";
export const SCOPE_WRITE = "foxhound_admin:write";
export const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE];
