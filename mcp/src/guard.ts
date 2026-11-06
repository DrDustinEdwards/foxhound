import { callAdminApi } from "./api-client";
import type { AdminMcpEnv } from "./env";

// Who is a Foxhound admin, asked of the admin API. The door itself (audience,
// Origin, Host, rate limit, the OAuth provider) is site-runtime's adminMcpWorker
// (index.ts).

/** Whether the admin API takes this email for an admin. Asked at sign-in and on every request. */
export async function isFoxhoundAdmin(env: AdminMcpEnv, email: string): Promise<boolean> {
  const answer = await callAdminApi(env, email, { method: "GET", path: "/me" });
  return answer.ok;
}
