import { type MiddlewareFunction, redirect } from "react-router";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";

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
  if (!session) throw redirect("/login");

  const membership = await resolveMembership(getDb(env), session.user.id);
  if (!membership) throw redirect("/connect");

  context.set(authContext, {
    userId: session.user.id,
    userName: session.user.name,
    email: session.user.email,
    membership,
    isAdmin: isAdminEmail(env, session.user.email),
  });
  return next();
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
