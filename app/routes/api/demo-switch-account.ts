import { findDemoBusiness, setActiveDemoAccountCookieHeader } from "~/lib/demo/session";

import type { Route } from "./+types/demo-switch-account";
import { readAccountId, refusePost } from "~/lib/http/account-post";

// Switch which demo business the demo shows: the id must be one of DEMO_BUSINESSES, else 400, and the answer is JSON. The switcher then hard-navigates so every loader re-reads. Not a save: it sets a cookie naming a demo business and touches no row, so the demo stays read-only. It sits outside the app shell, whose demo guard refuses every POST, for the same reason /demo/exit does. ACTION ONLY, no loader, as app/routes/api/account-switch.ts.
export async function action({ request }: Route.ActionArgs) {
  const refused = refusePost(request);
  if (refused) return refused;
  const business = findDemoBusiness(await readAccountId(request));
  if (!business) {
    return Response.json({ error: "Invalid demo account" }, { status: 400 });
  }
  return Response.json(
    { success: true },
    { headers: { "Set-Cookie": setActiveDemoAccountCookieHeader(business) } },
  );
}
