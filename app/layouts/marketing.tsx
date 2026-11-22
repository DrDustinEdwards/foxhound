import { Outlet } from "react-router";

import { getDb } from "~/db";
import { Footer } from "~/components/footer";
import { Header } from "~/components/header";
import { listMemberships, resolveActiveMembershipFrom } from "~/lib/auth/account";
import { isAdminEmail } from "@dustinedwards/site-runtime/access";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { getSession } from "~/lib/auth/session";
import { listSwitcherAccounts } from "~/lib/nav/accounts.server";
import { resolveThemeForRequest } from "~/lib/theme.server";

import type { Route } from "./+types/marketing";
// One cue more per kind of link on the public pages: another site, a file, mail (Capsomer's link
// system; the base cues are app.css's capsomer/links.css).
import "capsomer/link.css";
import "~/marketing.css";

// Anonymous visitors stay zero-DB. An authenticated visitor additionally resolves their memberships (for the account switcher), without resolveNavContext's last-visited-product logic, which marketing pages have no use for.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // Same resolver the root loader uses, so the toggle's icon and <html data-theme> cannot disagree for a merchant whose stored theme differs from this device's cookie.
  const theme = await resolveThemeForRequest(env, request);
  const session = await getSession(env, request);

  if (!session) {
    return {
      isAuthenticated: false as const,
      theme,
      isAdmin: false,
      accountLabel: "",
      hasAccount: false,
      // Anonymous visitors stay ZERO-DB: an empty list is a constant, not a query, and the header renders no switcher for them.
      accounts: [],
      activeAccountId: null,
      userName: null,
      email: "",
    };
  }

  const db = getDb(env);
  // Resolved with `resolveAccount`, as the app shell does, not `resolveMembership`, which always picks the EARLIEST membership: a merchant who switched accounts and then opened /pricing would see the header reporting the account they switched away from. This layout is NOT under appShellMiddleware, so there is no authContext to read; it resolves the same way the chokepoint does, off the same session marker.
  const memberships = await listMemberships(db, session.user.id);
  const membership = await resolveActiveMembershipFrom(
    db,
    memberships,
    session.session.activeAccountId ?? null,
  );
  return {
    isAuthenticated: true as const,
    theme,
    // The switcher's rows, assembled in the nav's own loader with a separate stripe_connections query, never in the account resolver.
    accounts: await listSwitcherAccounts(db, memberships),
    activeAccountId: membership?.accountId ?? null,
    // Both are free here: isAdminEmail is an env lookup, and the membership resolved above carries the account name, so the avatar menu costs the marketing loader no extra query.
    isAdmin: isAdminEmail(env, session.user.email),
    accountLabel: membership?.accountName ?? session.user.email,
    // Gates the avatar menu's Billing row; the membership is already resolved, so it costs nothing extra.
    hasAccount: membership !== null,
    // Who you are, the first line of the avatar menu: off the session already
    // in hand, no query.
    userName: session.user.name || null,
    email: session.user.email,
  };
}

export default function MarketingLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="fh-page-frame fh-text">
      <Header
        isAuthenticated={loaderData.isAuthenticated}
        theme={loaderData.theme}
        isAdmin={loaderData.isAdmin}
        accountLabel={loaderData.accountLabel}
        hasAccount={loaderData.hasAccount}
        accounts={loaderData.accounts}
        activeAccountId={loaderData.activeAccountId}
        userName={loaderData.userName}
        email={loaderData.email}
        skipTo="#main"
      />
      <main id="main" className="fh-marketing-block">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
