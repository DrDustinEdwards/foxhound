import { data, type MiddlewareFunction, redirect } from "react-router";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { DEMO_MEMBER_EMAIL } from "~/lib/demo/constants";
import {
  activeDemoBusiness,
  DEMO_READ_ONLY_MESSAGE,
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
import { isAdminEmail } from "./roles";
import { getSession } from "./session";

// Server middleware (runs on the server for initial loads AND client-navigation
// data requests, where the Cloudflare env is available). These guard the route
// trees defined in ROUTES.md.

// Since job_6566f4776fdf /admin is no longer under the app shell at all (it has
// its own layout behind Cloudflare Access, app/layouts/admin-shell.tsx), so
// this middleware never sees an /admin request. The /admin exclusion below is
// kept as a pure rule so a future route under the app shell at /admin cannot
// quietly resolve to the demo.
//
// /admin always resolves from the real session, never the demo cookie (see
// the precedence rule documented on appShellMiddleware below). Matched by
// pathname rather than by route tree position: this middleware runs before
// the nested admin-guard layout's own middleware, so it has no way to know
// yet whether the eventual match is under /admin. Exported as a pure,
// string-in-string-out function (same "pure decision, unit-testable"
// convention as demoBlocksMethod in lib/demo/session.ts) so the precedence
// rule below can be tested without mocking a Request or a session.
export function isAdminPath(pathname: string): boolean {
  // Strips the ".data" suffix RR8's single-fetch protocol appends to
  // client-navigation requests (same pattern as app-shell.tsx's own
  // requestPathname).
  const clean = pathname.endsWith(".data") ? pathname.slice(0, -".data".length) : pathname;
  return clean === "/admin" || clean.startsWith("/admin/");
}

// The demo-over-session precedence decision itself, as a pure function of
// the three inputs it actually depends on, so the rule documented on
// appShellMiddleware below is directly unit-testable.
export function resolvesToDemo(hasSession: boolean, demoCookiePresent: boolean, pathname: string): boolean {
  if (!demoCookiePresent) return false;
  if (!hasSession) return true; // anonymous demo visitor: unchanged, always demo
  return !isAdminPath(pathname); // signed-in: demo wins everywhere except /admin
}

/**
 * App-shell guard: every authenticated route requires a session and a resolved
 * account, OR a valid read-only demo view. On success, publishes the caller's
 * identity + membership + admin flag on authContext for downstream
 * loaders/actions.
 *
 * Demo-over-session precedence (TASK-foxhound-demo-access-parity.md): a real
 * session no longer unconditionally wins. When the demo cookie is present on
 * a non-admin path, the DEMO membership resolves even for a signed-in caller
 * (resolvesToDemo above), so a signed-in visitor can preview the demo without
 * signing out first. The rule, explicitly:
 *   - /admin is EXCLUDED from this precedence, always. resolvesToDemo(true,
 *     true, "/admin...") is false, so a signed-in admin who also carries a
 *     demo cookie still resolves their real, admin-capable session on every
 *     /admin route, exactly as before this change. They cannot lose admin
 *     surfaces by carrying a demo cookie.
 *   - The demo account ids are still hardcoded constants (DEMO_BUSINESSES).
 *     The active-business cookie only picks among them, and an id outside
 *     that list falls back to the first, so neither the cookie nor the
 *     session can make the demo resolve to a real account.
 *   - The no-session path is untouched: an anonymous demo visitor (no
 *     session at all) resolves the demo exactly as before, on every path
 *     including /admin (demo authContext is hardcoded isAdmin=false
 *     below; /admin itself now sits behind Cloudflare Access).
 *   - The read-only method gate (demoBlocksMethod) and the seeded-membership
 *     check (resolveDemoMembership) are unchanged; only which caller reaches
 *     them is new.
 */
export const appShellMiddleware: MiddlewareFunction<Response> = async (args, next) => {
  const { request, context } = args;
  if (!hasImpersonationCookie(request)) return resolveSessionOrDemo(args, next);

  // An admin viewing a merchant ("View as merchant", app/lib/admin/
  // impersonation.server.ts). READ-ONLY FIRST: the cookie alone refuses every
  // non-GET/HEAD with 405, before any session, membership or database work, the
  // demo firewall's rule and its demoBlocksMethod. A stale
  // cookie therefore blocks writes too, until Stop or its own expiry clears it.
  if (demoBlocksMethod(request.method)) {
    throw data(IMPERSONATION_READ_ONLY_MESSAGE, { status: 405 });
  }

  // The account is never read from the cookie: the cookie is an
  // opaque token, and the account comes from its server-side row, honored only
  // while that row is open and unexpired AND its admin passes Cloudflare Access
  // on this very request. Anything else falls through to the caller's own
  // session or demo, and the dead cookie is cleared on the way out.
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
      // The merchant's view, so no admin-only affordance inside it.
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
    if (thrown instanceof Response) thrown.headers.append("Set-Cookie", clearImpersonationCookieHeader());
    throw thrown;
  }
};

const resolveSessionOrDemo: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  const { env } = context.get(cloudflareContext);
  const pathname = new URL(request.url).pathname;
  // Hard rule 10: a demo write is refused before any session or database work.
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
    // them resolves an account itself (parity/MULTI-ACCOUNT-QUERY-AUDIT.md), so
    // whichever account is decided here is the account every one of them acts
    // on, including the money routes. That is why the marker is passed HERE and
    // nowhere else.
    //
    // `session.session.activeAccountId` NOW HAS A WRITER, as of phase (b):
    // app/routes/api/account-switch.ts, and the invite accept. It is still null
    // for every session that has not switched, and the fallback for that case is
    // the earliest membership, byte for byte what resolveMembership did before
    // ruling 326. (This paragraph said "null for every session in existence" at
    // phase (a); that was true when it was written and phase (b) is what made it
    // false, so it is corrected here rather than left reading as current.)
    //
    // ONE membership query per request, not two: phase (b) needs both the full
    // list (AuthContext.memberships) and the resolved one, so the list is
    // fetched here and `resolveActiveMembershipFrom` picks from it. The only
    // extra query is legacy's last_visited_path tier, and that runs only when a
    // user holds MORE than one membership and the marker missed.
    const db = getDb(env);
    const memberships = await listMemberships(db, session.user.id);
    const membership = await resolveActiveMembershipFrom(
      db,
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
    // can read the friendly message back off error.data instead of falling
    // back to the generic "Method Not Allowed" HTTP reason phrase.
    if (demoBlocksMethod(request.method)) {
      throw data(DEMO_READ_ONLY_MESSAGE, { status: 405 });
    }
    // Every seeded demo business, and the one the visitor last switched to
    // (legacy's active_demo_account), else the first seeded one.
    const memberships = await resolveDemoMemberships(getDb(env));
    const wanted = activeDemoBusiness(request).accountId;
    const membership = memberships.find((m) => m.accountId === wanted) ?? memberships[0];
    const business = membership ? findDemoBusiness(membership.accountId) : null;
    if (!membership || !business) {
      // Demo not seeded yet. A signed-in caller falls back to their own
      // dashboard rather than the marketing /demos page; an anonymous
      // visitor goes to /demos as before.
      throw redirect(demoFallbackPath(Boolean(session)));
    }
    context.set(authContext, {
      userId: business.memberUserId,
      userName: business.name,
      email: DEMO_MEMBER_EMAIL,
      membership,
      // The demo businesses, for the account switcher, as legacy's SiteNav.tsx
      // listed DEMO_ACCOUNTS in the demo. A signed-in visitor previewing the
      // demo must NOT see their real accounts offered here, so this is the demo
      // memberships alone, never anything read from their session. The demo_
      // firewall is unchanged.
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
