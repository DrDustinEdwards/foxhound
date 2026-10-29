import { redirect } from "react-router";

import { revokeAuditGrant, scheduleAuditGrantRevoke } from "~/lib/audit/grant-revoke.server";
import { RATE_LIMIT_AUDIT, STRIPE_AUDIT_SCOPE } from "~/lib/constants";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { exchangeConnectCode } from "~/lib/stripe/connect";
import { AUDIT_ACTION, verifyConnectState } from "~/lib/stripe/connect-state";
import {
  clearAuditStateCookie,
  readAuditStateCookie,
  setAuditGrantCookie,
} from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/callback";

// Legacy's `app/audit/callback/route.ts` (blob `0cf90598`, 2,517 bytes), phase (f).
//
// WHAT THIS ROUTE WRITES: ONE COOKIE AND ONE DELAYED QUEUE MESSAGE. No account
// row, no membership, no `stripe_connections` row, no billing surface, nothing
// in D1 at all. Legacy is the same on D1: its callback touches no table, and the
// whole anonymous grant lives in a five-minute HttpOnly cookie scoped to
// /audit. That is why an anonymous audit of a Stripe account ALREADY CONNECTED
// to some Foxhound account raises no conflict with `stripe_connections_live_stripe_account_uq` (356, DEFECT 4): the
// global unique index is never engaged, because this path inserts no connection.
//
// THE STATE MUST SAY "audit". `verifyConnectState` returns the action, and
// anything other than AUDIT_ACTION is refused here, exactly as
// `/connect/callback` refuses AUDIT_ACTION on its side. An anonymous audit grant
// and an onboarding grant can therefore never be spent on each other's branch,
// which is what the third action in the shared state shape bought.
//
// THE GRANTED SCOPE IS CHECKED, NOT ASSUMED: the token response carries the
// scope Stripe actually granted, and anything but STRIPE_AUDIT_SCOPE is refused.
// 362 ruling 1 made that scope read_only; on 2026-10-29 Stripe's live authorize
// page refused read_only with a 400 ("Please use the `read_write` scope"),
// because only Extensions may use it, so the scope is read_write again and the
// check now expects read_write (see STRIPE_AUDIT_SCOPE in constants.ts).
//
// FOXHOUND REVOKES THE GRANT ITSELF, where legacy never revoked anything. Right
// after the exchange, before any check that could bounce, a revoke is queued
// for when the cookie's window (AUDIT_TOKEN_TTL_SECONDS) ends; at delivery it is
// skipped if any Foxhound account holds that Stripe account live
// (app/lib/audit/grant-revoke.server.ts). If the queue send fails the grant is
// revoked now, with the same live-connection check, and the run is refused,
// because a grant nobody will revoke is the one outcome this must not allow.

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = new URL(request.url);

  // Every exit clears the state cookie, so a refused flow cannot leave a live
  // nonce behind for a second attempt to match against.
  const bounce = (reason: string) =>
    redirect(`/audit/connect?error=${reason}`, {
      headers: { "Set-Cookie": clearAuditStateCookie() },
    });

  // 311's limiter, used unchanged, at legacy's numbers on legacy's second key.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const allowed = await isWithinRateLimit(
    env,
    "audit-callback",
    ip,
    RATE_LIMIT_AUDIT.max,
    RATE_LIMIT_AUDIT.windowMs,
  );
  if (!allowed) return bounce("rate_limited");

  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) return bounce("cancelled");

  // The whole trust decision before the code is exchanged: byte-identical to the
  // HttpOnly cookie, parses to a known action, and that action is this flow's.
  const action = verifyConnectState(url.searchParams.get("state"), readAuditStateCookie(request))?.action;
  if (action !== AUDIT_ACTION) return bounce("invalid_state");

  try {
    const oauth = await exchangeConnectCode(env, code);

    try {
      await scheduleAuditGrantRevoke(env, oauth.stripeUserId);
    } catch {
      console.error("audit grant revoke could not be queued; revoking now and refusing the run");
      const outcome = await revokeAuditGrant(env, oauth.stripeUserId).catch(() => "failed");
      console.error(`audit grant revoke: ${outcome}`);
      return bounce("failed");
    }

    if (oauth.scope !== STRIPE_AUDIT_SCOPE) {
      // Do not log the scope value with the account id; the refusal itself is
      // the signal worth having, and it is the loud kind on purpose.
      console.error("audit OAuth returned a scope other than STRIPE_AUDIT_SCOPE; refusing the run");
      return bounce("scope_refused");
    }

    // Legacy's own comment, and its reasoning is right: the token must not travel
    // in the URL (history, logs, referrer leakage). The account id stays in the
    // query to keep legacy's URL, but it is NOT what the results page trusts:
    // the id Stripe returned is sealed into the cookie with the token, and the
    // page refuses a query that disagrees with it.
    const target = new URL("/audit/results", url.origin);
    target.searchParams.set("account", oauth.stripeUserId);

    let grantCookie: string;
    try {
      grantCookie = await setAuditGrantCookie(env, {
        accessToken: oauth.accessToken,
        stripeAccountId: oauth.stripeUserId,
      });
    } catch {
      // The only way sealing fails is a missing or malformed ENCRYPTION_KEY,
      // which would end every audit here. One fixed line so it is visible; the
      // error object is never logged, since the plaintext was a live token.
      console.error("audit grant seal failed: check ENCRYPTION_KEY");
      return bounce("failed");
    }

    return redirect(target.pathname + target.search, {
      headers: [
        ["Set-Cookie", clearAuditStateCookie()],
        ["Set-Cookie", grantCookie],
      ],
    });
  } catch {
    // Never log the error object: a Stripe request error can carry the exchanged
    // token. Legacy logs `err` here, which is the one line of its callback not
    // ported. Its separate `oauth_failed` branch collapses into this one because
    // `exchangeConnectCode` throws on a partial token response rather than
    // returning one, so there is no second case left to distinguish.
    return bounce("failed");
  }
}
