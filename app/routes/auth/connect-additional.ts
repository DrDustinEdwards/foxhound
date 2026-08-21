import { redirect } from "react-router";

import { getDb } from "~/db";
import { getSession, listMemberships } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildConnectAuthorizeUrl } from "~/lib/stripe/connect";
import { ADD_ACCOUNT_ACTION, buildConnectState } from "~/lib/stripe/connect-state";
import { setStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect-additional";

// The switcher's "+ Add account". Legacy's
// app/api/stripe/connect-additional/route.ts (blob `60f93b27`, 1,545 bytes):
// verify the caller already has an account, then start Stripe OAuth with
// `action: 'add_account'` encoded into the state "so the callback creates a new
// account".
//
// THE FAIL-CLOSED GUARD PHASE (e) PUT HERE IS GONE, and its removal is the point
// of phase (d). That guard refused the flow whenever the ACTIVE account differed
// from the EARLIEST one, because `connect-callback.ts` resolved with the
// null-marker shim and would have attached the new Stripe account to the wrong
// merchant's ledger. The callback no longer resolves that way: `add_account`
// now mints its own account and never touches an existing one, so the question
// the guard was asking has no answer to get wrong. Its `add_account_unavailable`
// error param is retired with it (ruling 329 ratified the guard as correct for
// its window and assigned this session to close the window).
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);

  // Legacy's own precondition (route.ts:16-27): you cannot add a SECOND account
  // without a first one. An accountless caller belongs in the setup flow.
  const memberships = await listMemberships(db, session.user.id);
  if (memberships.length === 0) throw redirect("/connect");

  if (!env.STRIPE_CLIENT_ID) {
    throw redirect("/connect?error=stripe_not_configured");
  }

  const state = buildConnectState(ADD_ACCOUNT_ACTION);
  return redirect(buildConnectAuthorizeUrl(env, state), {
    headers: { "Set-Cookie": setStateCookie(state) },
  });
}
