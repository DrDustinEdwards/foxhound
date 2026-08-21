import { redirect } from "react-router";

import { getDb } from "~/db";
import {
  getSession,
  listMemberships,
  resolveActiveMembershipFrom,
  resolveMembership,
} from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildConnectAuthorizeUrl } from "~/lib/stripe/connect";
import { buildAddAccountState } from "~/lib/stripe/connect-state";
import { setStateCookie } from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/connect-additional";

// THE FIRST HALF OF PHASE (d), and only the first half. Legacy's
// app/api/stripe/connect-additional/route.ts (blob `60f93b27`, 1,545 bytes):
// verify the caller already has an account, then start Stripe OAuth with
// `action: 'add_account'` encoded into the state "so the callback creates a new
// account".
//
// THE CALLBACK BRANCH THAT HONOURS THAT MARKER DOES NOT EXIST YET. Phase (d)
// builds it, and ruling 326 forbids this session from touching
// connect-callback.ts. Until then the marker is inert: the callback compares
// state to cookie by string equality and never parses it, so a flow started here
// lands in the SAME branch a /connect flow lands in.
//
// WHICH IS WHY THE GUARD BELOW EXISTS, and it is the part of this file worth
// reading twice. `connect-callback.ts:48` resolves its account with
// `resolveMembership`, the NULL-MARKER SHIM, so it attaches the new Stripe
// account to the caller's EARLIEST membership, not the one they are looking at.
// Before phase (e) that could not diverge, because with no switcher the earliest
// account was always the active one. Shipping the switcher is exactly what makes
// them able to differ, so this session would otherwise have introduced a path
// where a merchant on account B attaches a live payment processor to account A,
// silently and permanently: the webhook layer is correctly account-keyed and
// would honour the bad attachment forever (parity/MULTI-ACCOUNT-QUERY-AUDIT.md
// names this the single riskiest query in the codebase).
//
// So this route FAILS CLOSED when the two disagree, rather than starting a flow
// whose destination it cannot control. The check disappears in phase (d), when
// the callback reads the marker and creates its own account and the question
// stops being askable.
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

  const active = await resolveActiveMembershipFrom(
    db,
    memberships,
    session.session.activeAccountId ?? null,
  );
  const callbackWillResolve = await resolveMembership(db, session.user.id);
  if (!active || !callbackWillResolve || active.accountId !== callbackWillResolve.accountId) {
    // The caller is looking at one account and the callback would attach to
    // another. Refuse rather than guess: an unwanted connection on the wrong
    // merchant's ledger is not something a later session can cleanly undo.
    throw redirect("/connect?error=add_account_unavailable");
  }

  const state = buildAddAccountState(crypto.randomUUID());
  return redirect(buildConnectAuthorizeUrl(env, state), {
    headers: { "Set-Cookie": setStateCookie(state) },
  });
}
