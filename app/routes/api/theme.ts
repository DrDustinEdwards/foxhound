import { getDb } from "~/db";
import { resolveActiveMembership } from "~/lib/auth/account";
import { getSession } from "~/lib/auth/session";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { DEMO_READ_ONLY_MESSAGE, hasDemoCookie } from "~/lib/demo/session";
import { setAccountTheme } from "~/lib/theme.server";
import { isTheme } from "~/lib/theme";

import type { Route } from "./+types/theme";

// Persist an authenticated merchant's theme to accounts.theme so it follows
// them across devices (ruling 59). Legacy's equivalent is
// app/api/account/theme/route.ts, a POST that updates the account row.
//
// ACTION ONLY, deliberately: this route exports no loader. Loaders must not
// mutate, and the write helper it calls is documented action-only for the same
// reason.
//
// A GET is rejected by React Router itself with 400 before the action runs,
// because the route has no loader; verified against the deployed endpoint. The
// method check below therefore never sees a GET, and exists for the other
// non-POST verbs (PUT, PATCH, DELETE) that DO route to the action.
//
// The toggle calls this fire-and-forget: the DOM already flipped optimistically,
// so a failed write must not roll back what the merchant is looking at. The
// next request reconciles from the DB.
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  // Hard rule 10: the demo refuses a write before any session or database work.
  if (hasDemoCookie(request)) {
    return Response.json({ error: DEMO_READ_ONLY_MESSAGE }, { status: 405 });
  }

  const { env } = context.get(cloudflareContext);

  const session = await getSession(env, request);
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const theme = (payload as { theme?: unknown } | null)?.theme;
  if (!isTheme(theme)) {
    return Response.json({ error: "invalid_theme" }, { status: 400 });
  }

  const db = getDb(env);
  // THE ACTIVE ACCOUNT, not the earliest, and it has to move with the read in
  // lib/theme.server.ts or the pair disagrees: a merchant who had switched
  // would toggle, watch the row they are not looking at change, and see the
  // color snap back on the next request. Legacy resolves both halves the same
  // way (app/api/account/theme/route.ts, blob `968ba672`). Session 61, phase (c).
  const membership = await resolveActiveMembership(
    db,
    session.user.id,
    session.session.activeAccountId ?? null,
  );
  if (!membership) {
    return Response.json({ error: "no_account" }, { status: 404 });
  }

  await setAccountTheme(db, membership.accountId, theme);

  return Response.json({ theme });
}
