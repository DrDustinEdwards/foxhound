import { redirect } from "react-router";

import { getDb } from "~/db";
import { setSessionActiveAccount, safeReturnPath } from "~/lib/auth/active-account";
import { findActiveMembership } from "~/lib/auth/account";
import { getSession } from "~/lib/auth/session";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { readAccountId, refusePost } from "~/lib/http/account-post";

import type { Route } from "./+types/account-switch";

// Switch which account the current session is looking at. ACTION ONLY, no loader (as app/routes/api/theme.ts): loaders must not mutate. React Router answers a GET with 400 before the action runs when a route exports no loader, so the method check below is for the other non-POST verbs. The account switcher in app/components/site-header.tsx posts here.
export async function action({ request, context }: Route.ActionArgs) {
  const refused = refusePost(request, { demo: true });
  if (refused) return refused;

  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);

  // 401 for no user and 400 for a missing accountId, before the database is touched.
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accountId = await readAccountId(request);
  if (!accountId) {
    return Response.json({ error: "Missing accountId" }, { status: 400 });
  }

  // THE CHECK THE WHOLE ROUTE EXISTS FOR: a session may only be pointed at an account the caller ACTIVELY holds. Without it the marker is caller-controlled input naming somebody else's ledger, and every account-keyed query downstream would honor it. `findActiveMembership` is the shared query the invite accept also uses, so the two cannot drift on what membership means. A revoked or pending membership is not a membership and lands here as a 403.
  const db = getDb(env);
  const membership = await findActiveMembership(db, session.user.id, accountId);
  if (!membership) {
    return Response.json({ error: "Not a member of this account" }, { status: 403 });
  }

  await setSessionActiveAccount(db, session.session.id, accountId);

  // A fetch caller reloads the page itself; following a redirect would render the whole page for nothing.
  if (request.headers.get("content-type")?.includes("application/json")) {
    return new Response(null, { status: 204 });
  }

  // The redirect (or the caller's reload) IS the re-read: every loader under the app shell runs again and resolves through the new marker.
  return redirect(safeReturnPath(request.headers.get("referer"), request.url));
}
