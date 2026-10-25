import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useNavigation,
  useRouteLoaderData,
  useSubmit,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import {
  BarChart3,
  Bell,
  CalendarClock,
  CreditCard,
  FileText,
  LayoutDashboard,
  ListOrdered,
  Receipt,
  RotateCcw,
  Scale,
  Settings,
  TrendingDown,
  Undo2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { AdminShell, type AdminEntry } from "capsomer/react/admin-shell";
import { SiteHeader, type HeaderSwitcher } from "capsomer/react/site-header";
import "capsomer/admin-shell.css";
import "capsomer/time.css";

import { Footer } from "~/components/footer";
import { RouteSplash } from "~/components/route-splash";
import { businessSwitcher } from "~/components/nav/account-switcher";
import {
  businessRows,
  currentRow,
  headerLogo,
  personInitials,
  renderHeaderLink,
  THEME_PREF_KEY,
  useThemeMemory,
} from "~/components/site-header";
import { shouldShowRouteSplash } from "~/lib/navigation/route-splash";
import { appShellMiddleware } from "~/lib/auth/guards";
import { authContext } from "~/lib/auth/context";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { resolveErrorBoundaryDetails } from "~/lib/errors/boundary-message";
import { resolveNavContext } from "~/lib/nav/context.server";
import { listSwitcherAccounts } from "~/lib/nav/accounts.server";
import { PLATFORM_LINKS, PRODUCT_MANIFEST, PRODUCT_ORDER, type ProductKey, type ProductNavLink } from "~/lib/nav/manifest";
import { DEFAULT_THEME } from "~/lib/theme";
import { resolveThemeForRequest } from "~/lib/theme.server";
import { useCollapseKey } from "~/lib/use-collapse-key";
import { useReadAt } from "~/lib/use-read-at";

import type { loader as rootLoader } from "~/root";

import type { Route } from "./+types/app-shell";

// Server guard for the entire authenticated tree (session + account required).
export const middleware: Route.MiddlewareFunction[] = [appShellMiddleware];

// This layout's own route match never changes on a same-shell navigation
// (no params, no path segment of its own), so React Router's default
// revalidation heuristic skips re-running its loader when only a child
// route changes - even though the loader's own result (nav.activeProductKey)
// depends on the pathname. Without this, the switcher and primary links
// go stale on every client-side nav between products (caught visually:
// /console -> /recovery via the switcher left the header reading
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
// layout-rendered once, ZERO extra DB queries in the nav COMPONENTS themselves
// (resolveNavContext and listSwitcherAccounts run ONCE here; the components
// below only read the props they produced). And no admin-bypass hack (the real
// role guard governs /admin visibility, matching PRODUCT_MANIFEST's own gate).
//
// THE ACCOUNT SWITCHER IS BUILT AS OF RULING 326 PHASE (e). This comment said
// "No account switcher, because at HEAD a user holds at most one ACTIVE
// membership (`account_members_one_active_per_user_uq`)", which was a live
// invariant when written and is now false twice over: 324 struck that index and
// phase (a) replaced it with `account_members_user_account_active_uq` on
// (user_id, account_id). One of 232's carriers, discharged here by the build
// rather than by another repair to its wording.
//
// `auth.memberships` comes off the chokepoint (phase (b)); the
// stripe_connections lookup that turns it into switcher rows happens HERE, in
// the nav's own loader, per ruling 328 and per legacy's own structure
// (components/SiteNav.tsx:73-90, never resolveAccount).
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
    accounts: await listSwitcherAccounts(db, auth.memberships),
    activeAccountId: auth.activeAccountId,
    email: auth.email,
    isAdmin: auth.isAdmin,
    isDemo: auth.isDemo,
    demoSignedIn: auth.demoSignedIn,
    theme: await resolveThemeForRequest(env, request),
    nav,
    userName: auth.userName,
    // When this page's data was read, for the page bar's "Updated ..." line.
    readAt: Date.now(),
  };
}

// The merchant app on Capsomer's dashboard shell (AdminShell's user variant,
// capsomer 0.9.0), under the same site header as the public site. Dustin's
// answers of 2026-10-13 are approved differences from legacy, recorded in
// parity/APPROVED-DIFFERENCES.md: the business switcher on the left as a
// square tile, then the product switcher ("Acme Supply Co. / Recovery"); the
// avatar menu last in place of the gear; amber on the dark band; the product's
// pages as a 288px menu on the left in place of the links in the header row;
// a page bar naming the page and how fresh it is; and on a phone one row, a
// sheet for everything else, and a bottom bar of at most five tabs.
//
// Everything under the menu is the page as it was: the shell takes Foxhound's
// own neutrals (.fh-cap, app.css), so only the accents are amber, and every
// page keeps its own column.

const ICONS: Record<string, LucideIcon> = {
  "/console": LayoutDashboard,
  "/recovery/dashboard": RotateCcw,
  "/recovery/payments": CreditCard,
  "/recovery/sequence": ListOrdered,
  "/recovery/winback": Undo2,
  "/recovery/expiring-cards": CalendarClock,
  "/disputes/dashboard": Scale,
  "/intelligence/dashboard": BarChart3,
  "/intelligence/customers": Users,
  "/intelligence/churn": TrendingDown,
  "/intelligence/alerts": Bell,
  "/intelligence/reports": FileText,
  "/settings": Settings,
  "/billing": Receipt,
  "/settings/team": Users,
};

function icon(href: string) {
  const Icon = ICONS[href] ?? LayoutDashboard;
  return <Icon className="cap-admin-icon" aria-hidden />;
}


// A product's pages, or the product itself when it has one page.
function productPages(key: ProductKey): ProductNavLink[] {
  const product = PRODUCT_MANIFEST[key];
  return product.links.length > 0 ? product.links : [{ label: "Overview", to: product.href }];
}

// The menu's Account group: the three account pages the mockup's dashboard
// lists. Every other settings page stays in the avatar menu, as the gear had it.
const ACCOUNT_PAGES = ["Settings", "Billing", "Team"].flatMap((label) => PLATFORM_LINKS.filter((l) => l.label === label));

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { accountName, accounts, activeAccountId, email, isAdmin, isDemo, demoSignedIn, theme, nav, userName } =
    loaderData;
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const submit = useSubmit();
  useThemeMemory(theme, "account");
  useCollapseKey();
  const readAt = useReadAt(loaderData.readAt);
  const activeProduct = PRODUCT_MANIFEST[nav.activeProductKey];
  // Legacy's loading.tsx, ported to RR8's substrate (305). The decision lives in
  // a pure predicate so it can be tested without a DOM; see its header for why a
  // bare state check would blank this page during every money action.
  const splash = shouldShowRouteSplash(useNavigation());

  // The menu: the product you are in, its pages; then your account's pages. On
  // a platform page (settings, billing, help) the product is the last one you
  // visited, as the switcher already says.
  const pages = productPages(nav.activeProductKey);
  // A one-page product (Disputes) marks its one row on every page under it, as
  // it did when that row's href was the product's prefix (before J09 moved it
  // to /disputes/dashboard).
  const currentPage = nav.isPlatformPage
    ? undefined
    : (currentRow(pathname, pages) ?? (pages.length === 1 ? pages[0] : undefined));
  const currentAccountPage = currentRow(pathname, ACCOUNT_PAGES);
  const menu: AdminEntry[] = [
    ...pages.map((l) => ({
      id: l.to,
      label: l.label,
      href: l.to,
      group: activeProduct.label,
      icon: icon(l.to),
      current: l === currentPage,
    })),
    ...ACCOUNT_PAGES.map((l) => ({
      id: l.to,
      label: l.label,
      href: l.to,
      group: "Account",
      icon: icon(l.to),
      current: l === currentAccountPage,
    })),
  ];

  // The page bar's name: the page you are on, said once.
  const platformPage = currentRow(pathname, PLATFORM_LINKS);
  const pageName = currentPage
    ? currentPage.label === "Overview"
      ? `${activeProduct.label} overview`
      : currentPage.label
    : nav.isPlatformPage
      ? (platformPage?.label ?? "Foxhound")
      : activeProduct.label;

  // The phone's bottom bar keeps the tabs the app had, every product then
  // Billing and Settings, up to Capsomer's five (no More: the menu button opens
  // the full list). With Intelligence that is the four products and Settings;
  // Billing is in the avatar menu and the sheet.
  const tabLinks: Array<ProductNavLink & { product?: ProductKey }> = [
    ...PRODUCT_ORDER.filter((key) => key !== "intelligence" || nav.intelligenceEntitled).map((key) => ({
      label: PRODUCT_MANIFEST[key].label,
      to: PRODUCT_MANIFEST[key].href,
      product: key,
    })),
    ...["Billing", "Settings"].flatMap((label) => PLATFORM_LINKS.filter((l) => l.label === label)),
  ];
  // A product's tab goes to its dashboard (/recovery/dashboard, Recova's path,
  // J09) but stands for every page of the product, so it is matched on the
  // product the page belongs to, not on its own href.
  const currentTab = nav.isPlatformPage
    ? currentRow(pathname, tabLinks.filter((l) => !l.product))
    : tabLinks.find((l) => l.product === nav.activeProductKey);
  const tabs: AdminEntry[] = (
    tabLinks.length > 5 ? tabLinks.filter((l) => l.label !== "Billing") : tabLinks
  ).map((l) => ({
    id: `tab-${l.to}`,
    label: l.label,
    href: l.to,
    icon: icon(l.to),
    current: l === currentTab,
  }));

  // The switchers: the business (not in the demo, whose one hardcoded account
  // keeps the demo_ firewall as it was), then the product.
  const business = !isDemo && accounts.length > 0 ? businessSwitcher(accounts, activeAccountId) : null;
  const products: HeaderSwitcher = {
    id: "products",
    label: activeProduct.label,
    name: `Product: ${activeProduct.label}`,
    sheetLabel: "Products",
    groups: [
      {
        label: "Products",
        links: PRODUCT_ORDER.filter((key) => key !== "intelligence" || nav.intelligenceEntitled).map((key) => ({
          id: key,
          label: PRODUCT_MANIFEST[key].label,
          href: PRODUCT_MANIFEST[key].href,
          current: key === nav.activeProductKey,
        })),
      },
    ],
  };

  // The avatar menu, in place of the gear: who you are; the business's rows
  // under its name, Admin for an admin at their end (AdminShell's menu takes
  // one group of the app's rows); Help; Sign out last.
  const accountRows = businessRows(true);
  const currentAccountRow = currentRow(pathname, accountRows);

  return (
    <div className="fh-cap fh-app" data-cap-site="foxhound" data-family="amber">
      <AdminShell
        variant="user"
        // The app's name: the phone sheet's heading ("Foxhound menu") and,
        // with the page, the tab title ("Payments · Foxhound"), which
        // AdminShell sets on every app that uses it.
        title="Foxhound"
        nav={menu}
        navLabel={activeProduct.label}
        tabs={tabs}
        page={pageName}
        prefKey="foxhound-app"
        logo={headerLogo("/")}
        band="dark"
        switchers={business ? [business, products] : [products]}
        themePrefKey={THEME_PREF_KEY}
        renderLink={renderHeaderLink}
        updated={{ at: readAt }}
        status={
          <>
            <span className="fh-app-page-name">{pageName}</span>
            {isDemo ? (
              <span className="rounded border border-brand px-1.5 py-0.5 font-mono text-micro font-semibold uppercase tracking-wide text-brand-text">
                Demo
              </span>
            ) : null}
          </>
        }
        onHelp={() => void navigate("/help")}
        account={{
          name: userName || email,
          initials: personInitials(userName, email),
          email: userName ? email : undefined,
          appLabel: accountName ?? email,
          appLinks: [
            ...accountRows.map((l) => ({ label: l.label, href: l.to, current: l === currentAccountRow })),
            ...(isAdmin ? [{ label: "Admin", href: "/admin" }] : []),
          ],
          onSignOut: () => void submit(null, { method: "post", action: "/logout" }),
        }}
      >
        {/* The demo banner, at the top of the page under the page bar: the
            header is the first element on the page in every state, so the
            wordmark never moves between demo and signed-in. Always exactly two
            lines regardless of demoSignedIn, via the explicit <br />, so the
            banner's own height cannot vary between the two demo states. */}
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
              className="shrink-0 rounded-md border border-border px-2.5 py-1 text-label font-medium text-chrome-text hover:border-chrome-brand"
            >
              {demoSignedIn ? "Exit demo, return to your account" : "Exit demo"}
            </a>
          </div>
        ) : null}
        {/* Ruling 146: exactly one <main> on every app page. It is the shell's
            own (AdminShell's main region, #cap-main, the skip link's target),
            and the page renders inside it. Legacy replaces the SEGMENT's
            content with its splash and keeps the layout chrome mounted, so the
            header, menu and footer stay put and only the page swaps. The
            footer stays below the page, as legacy's SiteFooter is a sibling of
            the page content. */}
        <div className="fh-app-page">{splash ? <RouteSplash /> : <Outlet />}</div>
        <Footer variant="app" />
      </AdminShell>
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
  // The header's theme button still saves where the layout's did.
  const rootTheme = useRouteLoaderData<typeof rootLoader>("root")?.theme ?? DEFAULT_THEME;
  useThemeMemory(rootTheme, "account");

  return (
    <div>
      <div className="fh-cap fh-site-header" data-cap-site="foxhound" data-family="amber">
        <SiteHeader logo={headerLogo("/")} themePrefKey={THEME_PREF_KEY} sheetTitle="Foxhound menu" renderLink={renderHeaderLink} />
      </div>
      <main className="flex flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <h1 className="text-title font-medium text-text">{message}</h1>
        <p className="max-w-md text-body text-text-secondary">{details}</p>
        <Link to="/console" className="text-label text-brand-text hover:underline">
          Back to Foxhound
        </Link>
      </main>
    </div>
  );
}
