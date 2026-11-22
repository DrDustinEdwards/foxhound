import { redirect } from "react-router";

import { getDb } from "~/db";
import { getSession, listMemberships } from "~/lib/auth";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { buildConnectAuthorizeUrl } from "~/lib/stripe/connect";
import { ADD_ACCOUNT_ACTION, buildConnectState } from "~/lib/stripe/connect-state";
import { setStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect-additional";

// The switcher's "+ Add account": verify the caller already has an account, then start Stripe OAuth with `action: 'add_account'` encoded into the state so the callback creates a new account. The callback mints its own account for `add_account` and never touches an existing one, so no guard against an active account differing from the earliest one is needed.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);
  if (!session) throw redirect("/login");

  const db = getDb(env);

  // You cannot add a SECOND account without a first one. An accountless caller belongs in the setup flow.
  const memberships = await listMemberships(db, session.user.id);
  if (memberships.length === 0) throw redirect("/connect");

  if (!env.STRIPE_CLIENT_ID) {
    throw redirect("/connect?error=stripe_not_configured");
  }

  const state = buildConnectState(ADD_ACCOUNT_ACTION, session.user.id);
  return redirect(buildConnectAuthorizeUrl(env, state), {
    headers: { "Set-Cookie": setStateCookie(state) },
  });
}
