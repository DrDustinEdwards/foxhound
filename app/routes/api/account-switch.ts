import { redirect } from "react-router";

import { getDb } from "~/db";
import { setSessionActiveAccount, safeReturnPath } from "~/lib/auth/active-account";
import { findActiveMembership } from "~/lib/auth/account";
import { getSession } from "~/lib/auth/session";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/account-switch";

// Switch which account the current session is looking at. Legacy's
// app/api/account/switch/route.ts (blob `2b8c3628`, 1,141 bytes), which
// components/SiteNav.tsx names as `switchAccountUrl` for the non-demo case, at
// the same path: /api/account/switch.
//
// ACTION ONLY, no loader, following app/routes/api/theme.ts: loaders must not
// mutate. React Router answers a GET with 400 before the action runs when a
// route exports no loader, so the method check below is for the other non-POST
// verbs that DO reach the action.
//
// NO SWITCHER UI EXISTS YET. The control that calls this is phase (e), in both
// the marketing header (M1) and the app shell (S1). This route is the half that
// can ship without moving a pixel.
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);

  // Legacy's three checks, in legacy's order, with legacy's status codes.
  // route.ts:8-15 answers 401 for no user and 400 for a missing accountId before
  // it touches the database at all.
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accountId = await readAccountId(request);
  if (!accountId) {
    return Response.json({ error: "Missing accountId" }, { status: 400 });
  }

  // route.ts:17-28. THIS IS THE CHECK THE WHOLE ROUTE EXISTS FOR: a session may
  // only be pointed at an account the caller ACTIVELY holds. Without it the
  // marker is caller-controlled input naming somebody else's ledger, and every
  // account-keyed query downstream would honour it. `findActiveMembership` is
  // the shared query the invite accept also uses, so the two cannot drift on
  // what membership means. A revoked or pending membership is not a membership
  // and lands here as a 403, same as never having held the account.
  const db = getDb(env);
  const membership = await findActiveMembership(db, session.user.id, accountId);
  if (!membership) {
    return Response.json({ error: "Not a member of this account" }, { status: 403 });
  }

  await setSessionActiveAccount(db, session.session.id, accountId);

  // Legacy answers JSON and lets AccountSwitcher.tsx hard-navigate so server
  // components re-read. React Router has no such split, so the redirect IS the
  // re-read: every loader under the app shell runs again and resolves through
  // the new marker.
  return redirect(safeReturnPath(request.headers.get("referer"), request.url));
}

/** The posted account id, from a form body or a JSON body.
 *
 *  Legacy reads `await req.json()` only, because its switcher posts with fetch.
 *  Both are accepted here so phase (e) can render either a plain Form (which
 *  works with no JavaScript, and is what the redirect above is shaped for) or a
 *  fetch, without this route needing a second look. A body that is neither
 *  yields null and the 400 above. */
async function readAccountId(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const payload = (await request.json()) as { accountId?: unknown } | null;
      return typeof payload?.accountId === "string" && payload.accountId
        ? payload.accountId
        : null;
    }
    const form = await request.formData();
    const value = form.get("accountId");
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}
