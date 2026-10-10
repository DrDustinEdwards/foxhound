import { callAdminApi } from "./api-client";
import type { AdminMcpEnv } from "./env";

// The door's checks, kept free of the OAuth library so they run anywhere and
// are tested directly (door.ts wires them into the provider).

export const MCP_ROUTE = "/mcp";

/** What a grant stores, encrypted, and hands to every request made with it. */
export type DoorProps = { email: string; client: string; clientId: string };

export function adminMcpOrigin(env: Pick<AdminMcpEnv, "ADMIN_MCP_ORIGIN">): string {
  return (env.ADMIN_MCP_ORIGIN?.trim() || "https://admin-mcp.foxhoundapp.com").replace(/\/+$/, "");
}

/** Whether the admin API takes this email for an admin. Asked at sign-in. */
export async function isFoxhoundAdmin(env: AdminMcpEnv, email: string): Promise<boolean> {
  const answer = await callAdminApi(env, email, { method: "GET", path: "/me" });
  return answer.ok;
}

export type Guarded = { ok: true; email: string; client: string; scopes: string[] } | { ok: false; reason: string };

/**
 * The checks on every /mcp request after the provider has validated the token.
 * The audience must be this server's own resource (RFC 8707, rule 12.2), so a
 * token minted for any other server is refused here even if a provider were
 * ever set up for a second resource; and the grant must name the person.
 */
export function guardMcpRequest(
  origin: string,
  auth: { audience?: string; props?: Partial<DoorProps>; scope?: string[] },
): Guarded {
  if (auth.audience !== `${origin}${MCP_ROUTE}`) return { ok: false, reason: "audience" };
  const email = auth.props?.email;
  if (!email) return { ok: false, reason: "no-email" };
  return { ok: true, email, client: auth.props?.client || "an unnamed AI client", scopes: auth.scope ?? [] };
}

