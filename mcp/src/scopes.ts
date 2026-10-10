// Least scope first (MCP ruling rule 12.3). Every grant can read; a grant can
// pause and stage only when the client asked for write and the person did not
// narrow it to reading on the consent page.

export const SCOPE_READ = "foxhound_admin:read";
export const SCOPE_WRITE = "foxhound_admin:write";
export const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE];

export function grantScopes(requested: readonly string[], options: { readOnly?: boolean } = {}): string[] {
  const write = requested.includes(SCOPE_WRITE) && !options.readOnly;
  return write ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];
}
