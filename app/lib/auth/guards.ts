import { data, type MiddlewareFunction, redirect } from "react-router";

import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { DEMO_MEMBER_EMAIL, DEMO_READ_ONLY_MESSAGE } from "~/lib/demo/constants";
import {
  activeDemoBusiness,
  demoBlocksMethod,
  demoFallbackPath,
  findDemoBusiness,
  hasDemoCookie,
  resolveDemoMemberships,
} from "~/lib/demo/session";

import {
  clearImpersonationCookieHeader,
  hasImpersonationCookie,
  IMPERSONATION_READ_ONLY_MESSAGE,
  resolveImpersonation,
} from "~/lib/admin/impersonation.server";

import { listMemberships, resolveActiveMembershipFrom } from "./account";
import { authContext } from "./context";
import { isAdminEmail } from "@dustinedwards/site-runtime/access";
import { getSession } from "./session";

// /admin always resolves from the real session, never the demo cookie (see the
// precedence rule documented on appShellMiddleware below).
export function isAdminPath(pathname: string): boolean {
  // Strips the ".data" suffix RR8's single-fetch protocol appends to
  // client-navigation requests (same pattern as app-shell.tsx's own
  // requestPathname).
  const clean = pathname.endsWith(".data") ? pathname.slice(0, -".data".length) : pathname;
  return clean === "/admin" || clean.startsWith("/admin/");
}

// The demo-over-session precedence decision itself, as a pure function of the
// three inputs it actually depends on, so the rule documented on
// appShellMiddleware below is directly unit-testable.
export function resolvesToDemo(
  hasSession: boolean,
  demoCookiePresent: boolean,
  pathname: string,
): boolean {
  if (!demoCookiePresent) return false;
  if (!hasSession) return true; // anonymous demo visitor: unchanged, always demo
  return !isAdminPath(pathname); // signed-in: demo wins everywhere except /admin
}

/**
 * App-shell guard: every authenticated route requires a session and a resolved
 * account, OR a valid read-only demo view. On success, publishes the caller's
 * identity + membership + admin flag on authContext for downstream
 * loaders/actions.
 */
export const appShellMiddleware: MiddlewareFunction<Response> = async (args, next) => {
  const { request, context } = args;
  if (!hasImpersonationCookie(request)) return resolveSessionOrDemo(args, next);

  // An admin viewing a merchant ("View as merchant", app/lib/admin/
  // impersonation.server.ts). READ-ONLY FIRST: the cookie alone refuses every
  // non-GET/HEAD with 405, before any session, membership or database work, the
  // demo firewall's rule and its demoBlocksMethod.
  if (demoBlocksMethod(request.method)) {
    throw data(IMPERSONATION_READ_ONLY_MESSAGE, { status: 405 });
  }

  // The account is never read from the cookie: the cookie is an opaque token,
  // and the account comes from its server-side row, honored only while that row
  // is open and unexpired AND its admin passes Cloudflare Access on this very
  // request. Anything else falls through to the caller's own session or demo,
  // and the dead cookie is cleared on the way out.
  const { env } = context.get(cloudflareContext);
  const view = await resolveImpersonation(env, getDb(env), request, new Date());
  if (view) {
    context.set(authContext, {
      userId: view.userId,
      userName: view.userName,
      email: view.email,
      membership: view.membership,
      memberships: [view.membership],
      activeAccountId: view.membership.accountId,
      isAdmin: false,
      isDemo: false,
      demoSignedIn: false,
      viewingAs: { adminEmail: view.adminEmail },
    });
    return next();
  }

  try {
    const response = await resolveSessionOrDemo(args, next);
    response?.headers.append("Set-Cookie", clearImpersonationCookieHeader());
    return response;
  } catch (thrown) {
    if (thrown instanceof Response)
      thrown.headers.append("Set-Cookie", clearImpersonationCookieHeader());
    throw thrown;
  }
};

const resolveSessionOrDemo: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  const { env } = context.get(cloudflareContext);
  const pathname = new URL(request.url).pathname;
  // CLAUDE.md, Agent tools and demo: a demo write is refused before any session or database work.
  // With the cookie on a non-admin path the demo wins whether or not a session
  // exists (resolvesToDemo), so the session read is not needed to decide this.
  if (hasDemoCookie(request) && !isAdminPath(pathname) && demoBlocksMethod(request.method)) {
    throw data(DEMO_READ_ONLY_MESSAGE, { status: 405 });
  }
  const session = await getSession(env, request);
  const useDemo = resolvesToDemo(Boolean(session), hasDemoCookie(request), pathname);

  if (session && !useDemo) {
    // The ONE chokepoint that turns a session into an account for the whole app
    // shell: 27 files read `membership.accountId` off authContext and none of
    // them resolves an account itself, so whichever account is decided here is
    // the account every one of them acts on, including the money routes. That
    // is why the marker is passed HERE and nowhere else.
    const db = getDb(env);
    const memberships = await listMemberships(db, session.user.id);
    const membership = resolveActiveMembershipFrom(
      memberships,
      session.session.activeAccountId ?? null,
    );
    if (!membership) throw redirect("/connect");

    context.set(authContext, {
      userId: session.user.id,
      userName: session.user.name,
      email: session.user.email,
      membership,
      memberships,
      activeAccountId: membership.accountId,
      isAdmin: isAdminEmail(env, session.user.email),
      isDemo: false,
      demoSignedIn: false,
    });
    return next();
  }

  if (useDemo) {
    // Read-only choke point: every mutating action in this tree is a POST, so
    // blocking non-GET makes the whole demo surface look-but-don't-touch.
    // Thrown via data() (not a bare Response) so app/root.tsx's ErrorBoundary
    // can read the friendly message back off error.data instead of falling back
    // to the generic "Method Not Allowed" HTTP reason phrase.
    if (demoBlocksMethod(request.method)) {
      throw data(DEMO_READ_ONLY_MESSAGE, { status: 405 });
    }
    const memberships = await resolveDemoMemberships(getDb(env));
    const wanted = activeDemoBusiness(request).accountId;
    const membership = memberships.find((m) => m.accountId === wanted) ?? memberships[0];
    const business = membership ? findDemoBusiness(membership.accountId) : null;
    if (!membership || !business) {
      // Demo not seeded yet. A signed-in caller falls back to their own
      // dashboard rather than the marketing /demos page; an anonymous visitor
      // goes to /demos as before.
      throw redirect(demoFallbackPath(Boolean(session)));
    }
    context.set(authContext, {
      userId: business.memberUserId,
      userName: business.name,
      email: DEMO_MEMBER_EMAIL,
      membership,
      memberships,
      activeAccountId: membership.accountId,
      isAdmin: false,
      isDemo: true,
      demoSignedIn: Boolean(session),
    });
    return next();
  }

  throw redirect("/login");
};
