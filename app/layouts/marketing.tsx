import { Outlet } from "react-router";

import { getDb } from "~/db";
import { Footer } from "~/components/footer";
import { Header } from "~/components/header";
import { listMemberships, resolveActiveMembershipFrom } from "~/lib/auth/account";
import { isAdminEmail } from "~/lib/auth/roles";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getSession } from "~/lib/auth/session";
import { listSwitcherAccounts } from "~/lib/nav/accounts.server";
import { resolveThemeForRequest } from "~/lib/theme.server";

import type { Route } from "./+types/marketing";

// Anonymous visitors stay zero-DB (task: "Anonymous visitors stay zero-DB
// exactly as now"). An authenticated visitor additionally resolves their
// memberships (for the account switcher), without pulling in
// resolveNavContext's last-visited-product logic, which marketing pages have no use for
// (TASK-foxhound-marketing-header-v2.md).
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // Same resolver the root loader uses, so the toggle's icon and
  // <html data-theme> cannot disagree for a merchant whose stored theme
  // differs from this device's cookie (ruling 59).
  const theme = await resolveThemeForRequest(env, request);
  const session = await getSession(env, request);

  if (!session) {
    return {
      isAuthenticated: false as const,
      theme,
      isAdmin: false,
      accountLabel: "",
      hasAccount: false,
      // Anonymous visitors stay ZERO-DB (ruling 59): an empty list is a
      // constant, not a query, and the header renders no switcher for them.
      accounts: [],
      activeAccountId: null,
      userName: null,
      email: "",
    };
  }

  const db = getDb(env);
  // MOVED OFF THE NULL-MARKER SHIM (ruling 326 phase (e)). This called
  // `resolveMembership`, which always resolves the EARLIEST membership, so a
  // merchant who switched accounts and then opened /pricing saw the header
  // reporting the account they had switched away from. Legacy has no such split:
  // components/SiteNav.tsx calls the same `resolveAccount` on marketing pages as
  // in-app, and `section === 'marketing'` is in its own list of sections that
  // resolve an account.
  //
  // This layout is NOT under appShellMiddleware, so there is no authContext to
  // read the way the app shell does. It resolves the same way the chokepoint
  // does instead, off the same session marker.
  const memberships = await listMemberships(db, session.user.id);
  const membership = await resolveActiveMembershipFrom(
    db,
    memberships,
    session.session.activeAccountId ?? null,
  );
  return {
    isAuthenticated: true as const,
    theme,
    // The switcher's rows. Legacy assembles these in the nav's own loader with
    // a separate stripe_connections query, never in the account resolver.
    accounts: await listSwitcherAccounts(db, memberships),
    activeAccountId: membership?.accountId ?? null,
    // Both are free here: isAdminEmail is an env lookup, and the membership
    // resolved above carries the account name, so the gear dropdown costs the
    // marketing loader no extra query.
    isAdmin: isAdminEmail(env, session.user.email),
    accountLabel: membership?.accountName ?? session.user.email,
    // Legacy's hasAccount, gating the gear's Billing row. The membership is
    // already resolved above, so this costs the loader nothing extra.
    hasAccount: membership !== null,
    // Who you are, the first line of the avatar menu: off the session already
    // in hand, no query.
    userName: session.user.name || null,
    email: session.user.email,
  };
}

export default function MarketingLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
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
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
