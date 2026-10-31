import { callAdminApi } from "./api-client";
import type { AdminMcpEnv } from "./env";

// The door's own pieces, kept free of the OAuth library so they run anywhere
// and are tested directly. The audience, Origin and rate-limit checks are
// site-runtime's mcp-server (door.ts).

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
