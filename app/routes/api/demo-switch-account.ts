import { findDemoBusiness, setActiveDemoAccountCookieHeader } from "~/lib/demo/session";

import type { Route } from "./+types/demo-switch-account";

// Switch which demo business the demo shows. Legacy's
// app/api/demo/switch-account/route.ts (blob `f6786c87`), at the same path:
// the id must be one of the demo businesses (legacy's VALID_IDS, here
// DEMO_BUSINESSES), else 400, and the answer is legacy's JSON. The switcher
// then hard-navigates so every loader re-reads (app/components/nav/
// account-switcher.tsx switchAccount).
//
// Not a save: it sets a cookie naming a demo business and touches no row, so
// the demo stays read-only. It sits outside the app shell, whose demo guard
// refuses every POST, for the same reason /demo/exit does.
//
// ACTION ONLY, no loader, as app/routes/api/account-switch.ts.
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const business = findDemoBusiness(await readAccountId(request));
  if (!business) {
    return Response.json({ error: "Invalid demo account" }, { status: 400 });
  }
  return Response.json(
    { success: true },
    { headers: { "Set-Cookie": setActiveDemoAccountCookieHeader(business) } },
  );
}

/** The posted account id, from a JSON body (the switcher's fetch) or a form. */
async function readAccountId(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const payload = (await request.json()) as { accountId?: unknown } | null;
      return typeof payload?.accountId === "string" ? payload.accountId : null;
    }
    const value = (await request.formData()).get("accountId");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
