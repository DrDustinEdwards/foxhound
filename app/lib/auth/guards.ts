import { type MiddlewareFunction, redirect } from "react-router";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";

import {
  DEMO_ACCOUNT_NAME,
  DEMO_MEMBER_EMAIL,
  DEMO_MEMBER_USER_ID,
} from "~/lib/demo/constants";
import {
  demoBlocksMethod,
  hasDemoCookie,
  resolveDemoMembership,
} from "~/lib/demo/session";

import { resolveMembership } from "./account";
import { authContext } from "./context";
import { isAdminEmail } from "./roles";
import { getSession } from "./session";

// Server middleware (runs on the server for initial loads AND client-navigation
// data requests, where the Cloudflare env is available). These guard the route
// trees defined in ROUTES.md.

/**
 * App-shell guard: every authenticated route requires a session and a resolved
 * account. Unauthenticated -> /login; authenticated-but-no-account -> /connect
 * (account setup). On success, publishes the caller's identity + membership +
 * admin flag on authContext for downstream loaders/actions.
 */
export const appShellMiddleware: MiddlewareFunction<Response> = async (
  { request, context },
  next,
) => {
  const { env } = context.get(cloudflareContext);
  const session = await getSession(env, request);

  if (session) {
    const membership = await resolveMembership(getDb(env), session.user.id);
    if (!membership) throw redirect("/connect");

    context.set(authContext, {
      userId: session.user.id,
      userName: session.user.name,
      email: session.user.email,
      membership,
      isAdmin: isAdminEmail(env, session.user.email),
      isDemo: false,
    });
    return next();
  }

  // No real session: allow the read-only demo view iff the demo cookie is set.
  // The demo account id is a constant (never taken from the cookie), so this can
  // only ever resolve to the one demo account, and a real session always wins
  // above (a signed-in user is never put into demo mode).
  if (hasDemoCookie(request)) {
    // Read-only choke point: every mutating action in this tree is a POST, so
    // blocking non-GET makes the whole demo surface look-but-don't-touch.
    if (demoBlocksMethod(request.method)) {
      throw new Response("The demo is read-only.", { status: 405 });
    }
    const membership = await resolveDemoMembership(getDb(env));
    if (!membership) throw redirect("/demos"); // demo not seeded yet
    context.set(authContext, {
      userId: DEMO_MEMBER_USER_ID,
      userName: DEMO_ACCOUNT_NAME,
      email: DEMO_MEMBER_EMAIL,
      membership,
      isAdmin: false,
      isDemo: true,
    });
    return next();
  }

  throw redirect("/login");
};

/**
 * Admin guard: nests under the app-shell guard, so authContext is already set.
 * Non-admins get a 404 (not 403) so /admin's existence is not disclosed.
 */
export const adminOnlyMiddleware: MiddlewareFunction<Response> = async (
  { context },
  next,
) => {
  const auth = context.get(authContext);
  if (!auth.isAdmin) {
    throw new Response("Not Found", { status: 404 });
  }
  return next();
};
