import { Outlet } from "react-router";

import { getDb } from "~/db";
import { Footer } from "~/components/footer";
import { Header } from "~/components/header";
import { resolveMembership } from "~/lib/auth/account";
import { isAdminEmail } from "~/lib/auth/roles";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getSession } from "~/lib/auth/session";
import { isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import { getThemeFromRequest } from "~/lib/theme.server";

import type { Route } from "./+types/marketing";

// Anonymous visitors stay zero-DB (task: "Anonymous visitors stay zero-DB
// exactly as now"). An authenticated visitor additionally resolves their
// display initial (for the header avatar) and Intelligence entitlement (for
// the section pill's dropdown), reusing isIntelligenceEntitled directly
// rather than duplicating its query or pulling in resolveNavContext's
// last-visited-product logic, which marketing pages have no use for
// (TASK-foxhound-marketing-header-v2.md).
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const theme = getThemeFromRequest(request);
  const session = await getSession(env, request);

  if (!session) {
    return {
      isAuthenticated: false as const,
      theme,
      initial: null,
      intelligenceEntitled: false,
      isAdmin: false,
      accountLabel: "",
      hasAccount: false,
    };
  }

  const db = getDb(env);
  const membership = await resolveMembership(db, session.user.id);
  const intelligenceEntitled = membership ? await isIntelligenceEntitled(db, membership.accountId) : false;
  const displayName = session.user.name || session.user.email;
  const initial = displayName.charAt(0).toUpperCase();

  return {
    isAuthenticated: true as const,
    theme,
    initial,
    intelligenceEntitled,
    // Both are free here: isAdminEmail is an env lookup, and resolveMembership
    // (already awaited above for the entitlement check) carries the account
    // name, so the gear dropdown costs the marketing loader no extra query.
    isAdmin: isAdminEmail(env, session.user.email),
    accountLabel: membership?.accountName ?? session.user.email,
    // Legacy's hasAccount, gating the gear's Billing row. resolveMembership is
    // already awaited above, so this costs the loader nothing extra.
    hasAccount: membership !== null,
  };
}

export default function MarketingLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <Header
        isAuthenticated={loaderData.isAuthenticated}
        theme={loaderData.theme}
        initial={loaderData.initial}
        intelligenceEntitled={loaderData.intelligenceEntitled}
        isAdmin={loaderData.isAdmin}
        accountLabel={loaderData.accountLabel}
        hasAccount={loaderData.hasAccount}
      />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
