import { redirect } from "react-router";

import { RATE_LIMIT_AUDIT, STRIPE_AUDIT_SCOPE } from "~/lib/constants";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { exchangeConnectCode } from "~/lib/stripe/connect";
import { AUDIT_ACTION, verifyConnectState } from "~/lib/stripe/connect-state";
import {
  clearAuditStateCookie,
  readAuditStateCookie,
  setAuditTokenCookie,
} from "~/lib/stripe/state-cookie";

import type { Route } from "./+types/callback";

// Legacy's `app/audit/callback/route.ts` (blob `0cf90598`, 2,517 bytes), phase (f).
//
// WHAT THIS ROUTE WRITES: ONE COOKIE. No account row, no membership, no
// `stripe_connections` row, no billing surface, nothing in D1 at all. Legacy is
// the same: its callback touches no table, and the whole anonymous grant lives
// in a five-minute HttpOnly cookie scoped to /audit. That is why an anonymous
// audit of a Stripe account ALREADY CONNECTED to some Foxhound account raises no
// conflict with `stripe_connections_live_stripe_account_uq` (356, DEFECT 4): the
// global unique index is never engaged, because this path inserts no connection.
//
// THE STATE MUST SAY "audit". `verifyConnectState` returns the action, and
// anything other than AUDIT_ACTION is refused here, exactly as
// `/connect/callback` refuses AUDIT_ACTION on its side. A read-only audit grant
// and a read-write onboarding grant can therefore never be spent on each other's
// branch, which is what the third action in the shared state shape bought.
//
// THE GRANTED SCOPE IS CHECKED, NOT ASSUMED. 362 ruling 1 is about what the
// audit HOLDS, and the request parameter is only half of that: the token
// response carries the scope Stripe actually granted. If it comes back as
// anything but read-only the flow refuses rather than proceeding on a
// write-capable token for a stranger's account. Legacy neither requests
// read-only nor inspects what it got. FAIL CLOSED, portfolio canon, and the one
// arm of this route whose live Stripe behaviour is unverified: production Connect
// is not configured yet (core.md launch blocker 4), so this has been exercised
// against a fake client only.
//
// NO DEAUTHORIZE AFTER THE RUN, matching legacy, which never revokes anything:
// `deauthorize` appears nowhere in its tree. The cookie's expiry is the entire
// lifetime of the grant as far as anything Foxhound controls is concerned, since
// the token is stored in no table on either side.

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
  const action = verifyConnectState(url.searchParams.get("state"), readAuditStateCookie(request));
  if (action !== AUDIT_ACTION) return bounce("invalid_state");

  try {
    const oauth = await exchangeConnectCode(env, code);

    if (oauth.scope !== STRIPE_AUDIT_SCOPE) {
      // Do not log the scope value with the account id; the refusal itself is
      // the signal worth having, and it is the loud kind on purpose.
      console.error("audit OAuth returned a scope that is not read-only; refusing the run");
      return bounce("scope_refused");
    }

    // Legacy's own comment, and its reasoning is right: the token must not travel
    // in the URL (history, logs, referrer leakage). The account id is not
    // sensitive and stays in the query for the results page to read.
    const target = new URL("/audit/results", url.origin);
    target.searchParams.set("account", oauth.stripeUserId);

    return redirect(target.pathname + target.search, {
      headers: [
        ["Set-Cookie", clearAuditStateCookie()],
        ["Set-Cookie", setAuditTokenCookie(oauth.accessToken)],
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
