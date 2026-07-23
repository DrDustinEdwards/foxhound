import { Link, NavLink, Outlet, type ShouldRevalidateFunctionArgs } from "react-router";

import { Wordmark } from "~/components/wordmark";
import { GearMenu } from "~/components/nav/gear-menu";
import { ProductSwitcher } from "~/components/nav/product-switcher";
import { ThemeToggle } from "~/components/theme-toggle";
import { appShellMiddleware } from "~/lib/auth/guards";
import { authContext } from "~/lib/auth/context";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { resolveNavContext } from "~/lib/nav/context.server";
import { PLATFORM_LINKS, PRODUCT_MANIFEST, PRODUCT_ORDER } from "~/lib/nav/manifest";
import { getThemeFromRequest } from "~/lib/theme.server";

import type { Route } from "./+types/app-shell";

// Server guard for the entire authenticated tree (session + account required).
export const middleware: Route.MiddlewareFunction[] = [appShellMiddleware];

// This layout's own route match never changes on a same-shell navigation
// (no params, no path segment of its own), so React Router's default
// revalidation heuristic skips re-running its loader when only a child
// route changes - even though the loader's own result (nav.activeProductKey)
// depends on the pathname. Without this, the switcher and primary links
// go stale on every client-side nav between products (caught visually:
// /dashboard -> /recovery via the switcher left the header reading
// "Dashboard" until a hard reload).
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return currentUrl.pathname !== nextUrl.pathname || defaultShouldRevalidate;
}

// RR8's single-fetch protocol requests "<pathname>.data" on a client-side
// navigation (a real full-document request only on the initial SSR load), so
// request.url's pathname is literally "/recovery.data", not "/recovery", on
// every client nav. Caught visually: the switcher and primary links went
// stale on every in-app navigation until this was stripped (verified against
// the actual .data response body, not just the rendered page).
function requestPathname(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.endsWith(".data") ? pathname.slice(0, -".data".length) : pathname;
}

// Nav rebuild (TASK-foxhound-design-system-port.md Part 2): the three-level
// model (product switcher -> contextual primary links -> utility cluster),
// layout-rendered once, ZERO extra DB queries in the nav component itself
// (resolveNavContext runs ONCE here; the nav components below only read the
// props it produced). No account switcher (DESIGN.md: single-account by
// construction) and no admin-bypass hack (the real role guard governs /admin
// visibility, matching PRODUCT_MANIFEST's own gate).
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, ctx } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const pathname = requestPathname(request);
  const nav = await resolveNavContext(
    db,
    auth.membership.accountId,
    pathname,
    auth.isDemo,
    (promise) => ctx.waitUntil(promise),
  );

  return {
    accountName: auth.membership.accountName,
    email: auth.email,
    isAdmin: auth.isAdmin,
    isDemo: auth.isDemo,
    theme: getThemeFromRequest(request),
    nav,
  };
}

// The 2px amber bottom border is the ONLY sanctioned amber-on-active state
// (DESIGN.md) for the desktop primary links; NavLink sets aria-current="page"
// on the active link itself, nothing extra needed here.
function primaryLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive
    ? "inline-block border-b-2 border-amber py-3 text-label font-semibold text-text"
    : "inline-block border-b-2 border-transparent py-3 text-label text-text-tertiary hover:text-text";
}

// Mobile bottom tab bar is chrome (DESIGN.md: "nav/footer/mobile bar stay
// dark in both modes"), dark in both modes like the desktop header - so the
// active state uses the raw amber-ui token safely (amber on the always-dark
// chrome background is 9.2:1, review-verified), the same sanctioned adaptation
// as before (gotcha #57 - a bottom border reads oddly on a tab already at the
// screen's bottom edge), just now on the correct surface. Fresh-context review
// caught this rendering on bg-surface instead, which put the active tab's
// amber text on a white background in light mode at ~1.9:1 contrast.
function tabLinkClassName({ isActive }: { isActive: boolean }): string {
  return `flex flex-1 flex-col items-center gap-0.5 py-2 text-micro ${
    isActive ? "text-amber" : "text-chrome-text-tertiary"
  }`;
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { accountName, email, isAdmin, isDemo, theme, nav } = loaderData;
  const activeProduct = PRODUCT_MANIFEST[nav.activeProductKey];
  const primaryLinks = nav.isPlatformPage ? [] : activeProduct.links;

  // Mobile tab bar keeps its shipped, already-reviewed shape (gotcha #57):
  // every product plus Billing/Settings as flat tabs, not the desktop's
  // switcher + contextual-links split (375px has no room for both a
  // switcher and a sub-nav row). Intelligence is now entitlement-gated,
  // which it never was before this port.
  const mobileTabs: { label: string; to: string }[] = [
    ...PRODUCT_ORDER.filter((key) => key !== "intelligence" || nav.intelligenceEntitled).map((key) => ({
      label: PRODUCT_MANIFEST[key].label,
      to: PRODUCT_MANIFEST[key].href,
    })),
    ...PLATFORM_LINKS.filter((link) => link.label === "Billing" || link.label === "Settings"),
  ];

  return (
    <div>
      {isDemo ? (
        <div className="flex items-center justify-center gap-3 border-b border-border bg-chrome px-4 py-2 text-center">
          <span className="text-label text-chrome-text-secondary">
            You are viewing a live demo with sample data. Nothing you do here is saved.
          </span>
          <a
            href="/demo/exit"
            className="shrink-0 rounded-md border border-border px-2.5 py-1 text-label font-medium text-chrome-text hover:border-amber"
          >
            Exit demo
          </a>
        </div>
      ) : null}
      <header className="border-b border-border bg-chrome">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link to="/" aria-label="Foxhound home" className="shrink-0">
              <Wordmark tone="chrome" />
            </Link>
            <ProductSwitcher activeProductKey={nav.activeProductKey} intelligenceEntitled={nav.intelligenceEntitled} />
          </div>

          <div className="hidden min-w-0 items-center gap-4 sm:flex">
            <span className="min-w-0 truncate text-label text-chrome-text-secondary">
              {accountName ?? email}
            </span>
            <ThemeToggle initialTheme={theme} />
            <GearMenu isAdmin={isAdmin} />
          </div>

          <div className="flex items-center gap-1 sm:hidden">
            <ThemeToggle initialTheme={theme} />
            <GearMenu isAdmin={isAdmin} />
          </div>
        </div>

        {primaryLinks.length > 0 ? (
          <nav aria-label="Primary" className="mx-auto hidden max-w-6xl gap-6 px-4 md:flex">
            {primaryLinks.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end} className={primaryLinkClassName}>
                {link.label}
              </NavLink>
            ))}
          </nav>
        ) : null}
      </header>

      {/* Bottom padding reserves space for the fixed mobile tab bar below (a
          sibling of this container, never a flex body: DESIGN.md, avoids the
          position:fixed breakage on mobile Chrome). */}
      <div className="pb-16 md:pb-0">
        <Outlet />
      </div>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-chrome md:hidden"
      >
        {mobileTabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={tabLinkClassName}>
            <span className="w-full truncate text-center">{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
