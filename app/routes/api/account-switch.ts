import { refuseCrossSite } from "@dustinedwards/site-runtime/origin";
import { redirect } from "react-router";

import { getDb } from "~/db";
import { setSessionActiveAccount, safeReturnPath } from "~/lib/auth/active-account";
import { findActiveMembership } from "~/lib/auth/account";
import { getSession } from "~/lib/auth/session";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";
import { hasDemoCookie } from "~/lib/demo/session";

import type { Route } from "./+types/account-switch";
import { readForm, readJson } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// Switch which account the current session is looking at. ACTION ONLY, no loader (as app/routes/api/theme.ts): loaders must not mutate. React Router answers a GET with 400 before the action runs when a route exports no loader, so the method check below is for the other non-POST verbs. The account switcher in app/components/site-header.tsx posts here.
export async function action({ request, context }: Route.ActionArgs) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  // Hard rule 10: the demo refuses a write before any session or database work.
  if (hasDemoCookie(request)) {
    return Response.json({ error: DEMO_READ_ONLY_MESSAGE }, { status: 405 });
  }

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

  // The redirect IS the re-read: every loader under the app shell runs again and resolves through the new marker.
  return redirect(safeReturnPath(request.headers.get("referer"), request.url));
}

/** The posted account id, from a form body or a JSON body: a plain Form works with no JavaScript (what the redirect above is shaped for) and a fetch works too. A form or JSON body without it yields null and the 400 above; a body of any other type is the reader's 415. */
async function readAccountId(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const payload = (await readJson(request, BODY_MAX_BYTES)) as { accountId?: unknown } | null;
      return typeof payload?.accountId === "string" && payload.accountId ? payload.accountId : null;
    }
    const form = await readForm(request, BODY_MAX_BYTES);
    const value = form.get("accountId");
    return typeof value === "string" && value ? value : null;
  } catch (error) {
    if (error instanceof Response) throw error;
    return null;
  }
}
