import type { AdminMcpEnv } from "./env";

// The one way into Foxhound: the admin API at /api/admin/v1 on the foxhound
// Worker, over the FOXHOUND service binding.
//
// EVERY CALL CARRIES TWO CREDENTIALS. The admin key says the caller is this
// Worker; the acting admin's email says which person it is acting for. The API
// re-checks that email against ADMIN_EMAIL on every call, so a grant this Worker
// still holds stops working the moment the person stops being an admin. All the
// rules (what may be read, that pause is the only direct write, that money is
// staged) are the API's. This file holds none of them.

export const ADMIN_API_PREFIX = "/api/admin/v1";

/** A service binding ignores the host; this one only has to be a valid URL. */
const BINDING_ORIGIN = "https://foxhound.internal";

export type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: string };

export interface ApiCall {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | undefined>;
  body?: Record<string, unknown>;
}

/** One path segment, encoded, so an id can never step onto another route. */
export const segment = (value: string) => encodeURIComponent(value);

export async function callAdminApi(env: AdminMcpEnv, actor: string, call: ApiCall): Promise<ApiResult> {
  const key = env.FOXHOUND_ADMIN_API_KEY?.trim();
  if (!key) {
    return { ok: false, status: 503, error: "Foxhound Admin is not configured: FOXHOUND_ADMIN_API_KEY is unset." };
  }
  const url = new URL(`${ADMIN_API_PREFIX}${call.path}`, BINDING_ORIGIN);
  for (const [name, value] of Object.entries(call.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(name, value);
  }
  const response = await env.FOXHOUND.fetch(
    new Request(url, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Foxhound-Acting-Admin": actor,
        "Content-Type": "application/json",
      },
      body: call.method === "POST" ? JSON.stringify(call.body ?? {}) : undefined,
    }),
  );
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: unknown; error?: unknown } | null;
  if (response.ok && payload?.ok === true) {
    return { ok: true, data: (payload.data ?? {}) as Record<string, unknown> };
  }
  const error = typeof payload?.error === "string" ? payload.error : `Foxhound answered ${response.status}.`;
  return { ok: false, status: response.status, error };
}
