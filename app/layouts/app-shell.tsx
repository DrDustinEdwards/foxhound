import { Link, NavLink, Outlet, useNavigation, type ShouldRevalidateFunctionArgs } from "react-router";

import { Footer } from "~/components/footer";
import { RouteSplash } from "~/components/route-splash";
import { shouldShowRouteSplash } from "~/lib/navigation/route-splash";
import { Wordmark } from "~/components/wordmark";
import { GearMenu } from "~/components/nav/gear-menu";
import { ProductSwitcher } from "~/components/nav/product-switcher";
import { ThemeToggle } from "~/components/theme-toggle";
import { appShellMiddleware } from "~/lib/auth/guards";
import { authContext } from "~/lib/auth/context";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { resolveErrorBoundaryDetails } from "~/lib/errors/boundary-message";
import { resolveNavContext } from "~/lib/nav/context.server";
import { PLATFORM_LINKS, PRODUCT_MANIFEST, PRODUCT_ORDER } from "~/lib/nav/manifest";
import { resolveThemeForRequest } from "~/lib/theme.server";

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
// props it produced). No account switcher, because at HEAD a user holds at most
// one ACTIVE membership (`account_members_one_active_per_user_uq`, app/db/
// schema.ts), so there is nothing to switch between. This line used to cite
// DESIGN.md's "single-account by construction" rule, which ruling 53 revoked;
// repaired under ruling 232 to state the enforcing code instead of the dead
// authority. And no admin-bypass hack (the real role guard governs /admin
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
    demoSignedIn: auth.demoSignedIn,
    theme: await resolveThemeForRequest(env, request),
    nav,
  };
}

// The 2px amber bottom border is the ONLY sanctioned amber-on-active state
// (DESIGN.md) for the desktop primary links; NavLink sets aria-current="page"
// on the active link itself, nothing extra needed here. Both states carry
// the same border-b-2 (transparent when inactive) so a link's own box height
// never changes between active/inactive - and now that the links live in the
// single fixed-height header row (TASK-foxhound-app-shell-header-stability.md)
// rather than their own dedicated row, py-1.5 keeps them visually inline with
// the switcher/gear instead of the old py-3, which was sized for a row these
// links used to own by themselves.
function primaryLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive
    ? "inline-block border-b-2 border-amber py-1.5 text-label font-semibold text-text"
    : "inline-block border-b-2 border-transparent py-1.5 text-label text-text-tertiary hover:text-text";
}

// Mobile bottom tab bar is chrome (DESIGN.md: "nav/footer/mobile bar stay
// dark in both modes"), dark in both modes like the desktop header - so the
// active state uses the raw amber-ui token safely (amber on the always-dark
// chrome background is 9.2:1, review-verified), the same sanctioned adaptation
// as before (gotcha #57 - a bottom border reads oddly on a tab already at the
// screen's bottom edge), just now on the correct surface. Fresh-context review
// caught this rendering on bg-surface instead, which put the active tab's
// amber text on a white background in light mode at ~1.9:1 contrast.
// min-h-[56px] and justify-center are legacy's, from components/BottomTabBar.tsx
// (ruling 133 treatment item 2). The bar measured 34px here because py-2 was
// sizing it off its content; legacy names a floor instead and centres within it,
// so the two go together - min-h alone would top-align the label in a 56px box.
// Legacy also carries min-w-0, font-mono, text-[0.6875rem], gap-1, hover:text-amber
// and a text-chrome-text active state; those are recorded in parity/S-APP-SHELL.md
// as open treatment items, NOT built here, because the active-colour one is the
// divergence line 114's comment protects and it needs a ruling first.
function tabLinkClassName({ isActive }: { isActive: boolean }): string {
  return `flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-micro ${
    isActive ? "text-amber" : "text-chrome-text-tertiary"
  }`;
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { accountName, email, isAdmin, isDemo, demoSignedIn, theme, nav } = loaderData;
  const activeProduct = PRODUCT_MANIFEST[nav.activeProductKey];
  // Legacy's loading.tsx, ported to RR8's substrate (305). The decision lives in
  // a pure predicate so it can be tested without a DOM; see its header for why a
  // bare state check would blank this page during every money action.
  const splash = shouldShowRouteSplash(useNavigation());
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
    // Order is the tab bar's OWN and is deliberately not inherited from
    // PLATFORM_LINKS' array order. That array is now ordered for the gear
    // dropdown (legacy's Settings, Billing, Help), and iterating it directly
    // would have silently reshuffled these two tabs when the gear was
    // corrected. Still derived from it, so nav-manifest.test.ts keeps
    // asserting these hrefs exist in the real route tree.
    ...["Billing", "Settings"].flatMap((label) => PLATFORM_LINKS.filter((l) => l.label === label)),
  ];

  const accountLabel = accountName ?? email;

  return (
    <div>
      {/* Full-bleed, not mx-auto max-w-6xl (TASK-foxhound-header-geometry-
          unification.md): legacy's header is full viewport width on both
          the marketing site and the app (verified live and in the app
          screenshot), so a centered column here was the outlier, not the
          marketing header. Page bodies keep their own independent
          mx-auto max-w-* wrapper (every route under app-shell already has
          one), so this only changes the header's own geometry, not where
          page content sits - the same split legacy used. NOT sticky: this
          said "Sticky, matching the marketing header" until 2026-08-05, which
          had been false since 82bdc11 reverted it under ruling 47 (legacy's
          SiteNavClient carries no sticky/top/z anywhere, and ruling 47 governs
          both headers). The element below is a plain static h-14 row. The demo
          banner and page content are separate siblings below <header>, in
          normal flow. Stacking: the tab bar is z-50 at the bottom edge and the
          marketing drawer is z-40/z-50, but that drawer renders from
          layouts/marketing.tsx and never shares a document with this shell. */}
      <header className="h-14 border-b border-border bg-chrome">
        <div className="flex h-full items-center justify-between gap-4 px-6">
          <div className="flex min-w-0 shrink-0 items-center gap-3">
            <Link to="/" aria-label="Foxhound home" className="shrink-0">
              <Wordmark tone="chrome" />
            </Link>
            <ProductSwitcher activeProductKey={nav.activeProductKey} intelligenceEntitled={nav.intelligenceEntitled} />
            {isDemo ? (
              <span className="shrink-0 rounded border border-amber px-1.5 py-0.5 font-mono text-micro font-semibold uppercase tracking-wide text-amber">
                Demo
              </span>
            ) : null}
          </div>

          {/* Primary links and the utility cluster share one right-aligned
              group (TASK-foxhound-app-shell-header-stability.md): on a
              platform page or a product with no sub-links (Dashboard,
              Disputes), the <nav> below simply does not render - no reserved
              empty row, no height change, since the header's height comes
              from the row's own h-14, never from this content. */}
          <div className="flex min-w-0 items-center gap-6">
            {primaryLinks.length > 0 ? (
              <nav aria-label="Primary" className="hidden items-center gap-5 md:flex">
                {primaryLinks.map((link) => (
                  <NavLink key={link.to} to={link.to} end={link.end} className={primaryLinkClassName}>
                    {link.label}
                  </NavLink>
                ))}
              </nav>
            ) : null}

            <div className="hidden shrink-0 items-center gap-1 sm:flex">
              <ThemeToggle initialTheme={theme} isAuthenticated />
              <GearMenu isAdmin={isAdmin} accountLabel={accountLabel} hasAccount />
            </div>

            <div className="flex shrink-0 items-center gap-1 sm:hidden">
              <ThemeToggle initialTheme={theme} isAuthenticated />
              <GearMenu isAdmin={isAdmin} accountLabel={accountLabel} hasAccount />
            </div>
          </div>
        </div>
      </header>

      {/* Below the header, not above it (TASK-foxhound-app-shell-header-
          stability.md): the header is now the first element on the page in
          every state, so the wordmark's position never moves between demo
          and signed-in. Always exactly two lines regardless of
          demoSignedIn, via the explicit <br />, so the banner's own height
          cannot vary between the two demo states either - the alternative
          (a fixed pixel height) would be one more number to keep in sync
          with the font size instead of a structural guarantee. */}
      {isDemo ? (
        <div className="flex items-center justify-center gap-3 border-b border-border bg-chrome px-4 py-2 text-center">
          <span className="text-label text-chrome-text-secondary">
            You're viewing a live demo with sample data.
            <br />
            {demoSignedIn
              ? "Nothing you do here is saved. This is not your real account."
              : "Nothing you do here is saved."}
          </span>
          <a
            href="/demo/exit"
            className="shrink-0 rounded-md border border-border px-2.5 py-1 text-label font-medium text-chrome-text hover:border-amber"
          >
            {demoSignedIn ? "Exit demo, return to your account" : "Exit demo"}
          </a>
        </div>
      ) : null}

      {/* Bottom padding reserves space for the fixed mobile tab bar below (a
          sibling of this container, never a flex body: DESIGN.md, avoids the
          position:fixed breakage on mobile Chrome). The breakpoint follows the
          bar's: legacy's wrapper is pb-16 sm:pb-0 and its bar is sm:hidden, so
          the reserve and the thing it reserves for turn off together. Leaving
          this at md:pb-0 while the bar moved to sm:hidden would reserve 64px
          between 640 and 767 for a bar that is not rendered. */}
      <div className="pb-16 sm:pb-0">
        {/* Ruling 146. Legacy carries a <main> on every app page and Foxhound's
            authenticated tree carried NONE: `git grep "<main"` over
            app/routes/app/** returned zero, and the only one reachable under
            this shell was in the ErrorBoundary below, which renders only when a
            child route throws. Plain gap under PRIME DIRECTIVE item 1.

            Placed HERE rather than on each page, for three reasons. It closes
            the whole authenticated surface at once instead of the six rows the
            S2-S9 set walk happened to cover. It makes "exactly one" structural
            rather than a convention each new route has to remember, which is
            what item 3's marketing ratification turns on. And it matches
            Foxhound's own ratified pattern in layouts/marketing.tsx, which is
            likewise <main> in the layout carrying no container.

            Legacy's own <main> IS the width container (max-w-[1280px] etc). Here
            the container stays on the page, so Foxhound renders <main><div
            class="container">, one wrapper deeper than legacy. Landmark and
            rendered geometry are identical; the extra element is recorded rather
            than glossed. The footer stays OUTSIDE main, which is legacy's
            relationship too: legacy's SiteFooter is a layout sibling of the page
            content, never inside its main. */}
        <main>
          {/* Legacy replaces the SEGMENT's content with its splash and keeps the
              layout chrome mounted, so the nav and footer stay put and only the
              page swaps. Rendering it here, in place of the Outlet, is the same
              relationship on RR8's substrate. */}
          {splash ? <RouteSplash /> : <Outlet />}
        </main>
        {/* Legacy renders SiteFooter variant="app" INSIDE the padded wrapper and
            keeps the tab bar a sibling outside it (app/(app)/layout.tsx), so the
            fixed bar never overlaps the footer's bottom row on mobile. Same
            placement here for the same reason. */}
        <Footer variant="app" />
      </div>

      {/* Three of ruling 133's treatment items, all legacy's values from
          components/BottomTabBar.tsx. sm:hidden, not md:hidden: legacy cuts the
          bar off at 640px and Foxhound was showing one from 640 to 767 where
          legacy shows none. z-50, not z-10. And the safe-area inset, whose
          absence puts the bar under the iOS home indicator, which is a defect on
          hardware rather than a style preference. The inline style is legacy's
          own mechanism too: env() is a runtime device value, so it cannot be a
          build-time utility class. The marketing drawer also sits at z-40/z-50,
          which is fine because it renders from layouts/marketing.tsx and this
          renders from the app shell; the two never share a document. */}
      <nav
        aria-label="Primary"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
        className="fixed inset-x-0 bottom-0 z-50 flex border-t border-border bg-chrome sm:hidden"
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

// This does NOT catch appShellMiddleware's own throws (the demo read-only
// guard's 405, TASK-foxhound-demo-inline-refusal.md): middleware runs before
// this layout's loader, so a middleware throw has no rendered layout to
// attach to yet and is caught by root.tsx's ErrorBoundary instead (confirmed
// live, TASK-foxhound-header-geometry-unification.md - root's boundary has
// no header at all). What this DOES catch: an error thrown in a CHILD
// route's own loader or action, after appShellMiddleware has already
// succeeded and this layout has already rendered - a case root.tsx's bare
// boundary would otherwise render for, discarding the account name/nav/
// entitlement context this layout already resolved. Renders a minimal,
// self-contained header (no loaderData dependency) since a child-route
// error still leaves this layout's OWN loader's success ambiguous depending
// on where in the tree the error surfaced. Same message-selection logic as
// root.tsx, so a thrown data(message, {status}) still reads as its own
// message rather than a generic HTTP reason phrase.
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const { message, details } = resolveErrorBoundaryDetails(error, import.meta.env.DEV);

  return (
    <div>
      <header className="h-14 border-b border-border bg-chrome">
        <div className="flex h-full items-center px-6">
          <Link to="/" aria-label="Foxhound home">
            <Wordmark tone="chrome" />
          </Link>
        </div>
      </header>
      <main className="flex flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <h1 className="text-title font-medium text-text">{message}</h1>
        <p className="max-w-md text-body text-text-secondary">{details}</p>
        <Link to="/dashboard" className="text-label text-amber-text hover:underline">
          Back to Foxhound
        </Link>
      </main>
    </div>
  );
}
