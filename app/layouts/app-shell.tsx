import { PRIVATE_PAGE_HEADERS } from "@dustinedwards/site-runtime/edge-cache";
import { ButtonLink } from "capsomer/react/link";
import {
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
  useNavigation,
  useRouteLoaderData,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import {
  Icon,
  iconArrowLeft,
  iconCalendarClock,
  iconCard,
  iconDocument,
  iconIdea,
  iconListOrdered,
  iconOverview,
  iconPeople,
  iconReceipt,
  iconReset,
  iconScale,
  iconSettings,
  iconStats,
  iconTrendingDown,
  iconUndo,
} from "capsomer/react/icons";
import { AdminShell, type AdminEntry } from "capsomer/react/admin-shell";
import { initials } from "capsomer/behavior/avatar";
import { SiteHeader, type HeaderSwitcher } from "capsomer/react/site-header";
import { ErrorPage } from "capsomer/react/error-page";
import { ModeBanner } from "capsomer/react/mode-banner";
import { shouldShowRouteSplash } from "capsomer/behavior/route-splash";
import { RouteSplash } from "capsomer/react/route-splash";
import "capsomer/admin-shell.css";
import "capsomer/banner.css";
import "capsomer/mode-banner.css";
import "capsomer/button.css";
import "capsomer/route-splash.css";
import "capsomer/time.css";
import "~/app-pages.css";

import { Footer } from "~/components/footer";
import { isSettingsItemActive, SETTINGS_NAV_GROUPS } from "~/components/settings-sidebar";
import {
  ACCOUNT_SWITCH_URL,
  businessSwitcher,
  DEMO_ACCOUNT_SWITCH_URL,
} from "~/components/nav/account-switcher";
import {
  businessRows,
  currentRow,
  headerLogo,
  renderHeaderLink,
  THEME_PREF_KEY,
  themeMemory,
} from "~/components/site-header";
import { isSplashPath } from "~/lib/navigation/route-splash";
import { appShellMiddleware } from "~/lib/auth/guards";
import { refuseCrossSite } from "@dustinedwards/site-runtime/origin";
import { IMPERSONATION_STOP_PATH } from "~/lib/admin/impersonation.server";
import { authContext } from "~/lib/auth/context";
import { adminPageName as routePageName } from "~/lib/admin/page";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { errorDetails } from "~/lib/errors/boundary-message";
import { resolveNavContext } from "~/lib/nav/context.server";
import { listSwitcherAccounts } from "~/lib/nav/accounts.server";
import {
  PLATFORM_LINKS,
  PRODUCT_MANIFEST,
  PRODUCT_ORDER,
  type ProductKey,
  type ProductNavLink,
} from "~/lib/nav/manifest";
import { DEFAULT_THEME } from "~/lib/theme";
import { resolveThemeForRequest } from "~/lib/theme.server";
import { useReadAt } from "~/lib/use-read-at";

import { noindexHeader } from "~/lib/seo/meta";

import type { loader as rootLoader } from "~/root";

import type { Route } from "./+types/app-shell";

// Server guard for the entire authenticated tree (session + account required).
// ONLY THIS ORIGIN MAY WRITE, as in admin-shell.tsx: every merchant action
// under this shell, page or resource route, gets site-runtime's shared check
// before any session work.
const sameOriginWrites: Route.MiddlewareFunction = ({ request }, next) => {
  const refused = refuseCrossSite(request);
  if (refused) throw refused;
  return next();
};

// Hydrates: this page has client logic (root.tsx renders <Scripts/> only for a route that says so).
export const handle = { hydrate: true };

// Drawn for one reader and kept out of Web Analytics (site-runtime PRIVATE_PAGE_HEADERS); the children inherit it.
export const headers = () => PRIVATE_PAGE_HEADERS;

export const middleware: Route.MiddlewareFunction[] = [
  noindexHeader,
  sameOriginWrites,
  appShellMiddleware,
];

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
// `auth.memberships` comes off the chokepoint; the
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
    // An admin's read-only "View as merchant": the banner and its Stop.
    viewingAs: auth.viewingAs ? { stopHref: IMPERSONATION_STOP_PATH } : null,
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

const ICONS: Record<string, string> = {
  "/console": iconOverview,
  "/recovery/dashboard": iconReset,
  "/recovery/payments": iconCard,
  "/recovery/sequence": iconListOrdered,
  "/recovery/winback": iconUndo,
  "/recovery/expiring-cards": iconCalendarClock,
  "/disputes/dashboard": iconScale,
  "/intelligence/dashboard": iconStats,
  "/intelligence/customers": iconPeople,
  "/intelligence/recommendations": iconIdea,
  "/intelligence/churn": iconTrendingDown,
  "/intelligence/reports": iconDocument,
  "/settings": iconSettings,
  "/billing": iconReceipt,
};

function icon(href: string) {
  return <Icon d={ICONS[href] ?? iconOverview} className="cap-admin-icon" />;
}

// A product's pages, or the product itself when it has one page.
function productPages(key: ProductKey): ProductNavLink[] {
  const product = PRODUCT_MANIFEST[key];
  return product.links.length > 0 ? product.links : [{ label: "Overview", to: product.href }];
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const {
    accountName,
    accounts,
    activeAccountId,
    email,
    isAdmin,
    isDemo,
    demoSignedIn,
    viewingAs,
    theme,
    nav,
    userName,
  } = loaderData;
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const readAt = useReadAt(loaderData.readAt);
  const activeProduct = PRODUCT_MANIFEST[nav.activeProductKey];
  // Legacy's loading.tsx on RR8's substrate: Capsomer decides when (never during
  // the revalidation after a post), and the app names the paths.
  const splash = shouldShowRouteSplash(useNavigation(), isSplashPath);

  // The menu: the product you are in and its pages. On a settings page it is
  // the settings list instead, under a row back to the product, so a settings
  // page has one menu and not two side by side (Dustin 2026-10-29). Settings,
  // Billing and Team are in the avatar menu. On another platform page (billing,
  // help) the product is the last one you visited, as the switcher already says.
  const pages = productPages(nav.activeProductKey);
  // A one-page product (Disputes) marks its one row on every page under it, as
  // it did when that row's href was the product's prefix (before J09 moved it
  // to /disputes/dashboard).
  const currentPage = nav.isPlatformPage
    ? undefined
    : (currentRow(pathname, pages) ?? (pages.length === 1 ? pages[0] : undefined));
  const inSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const menu: AdminEntry[] = inSettings
    ? [
        {
          id: "back",
          label: `Back to ${activeProduct.label}`,
          href: activeProduct.href,
          icon: <Icon d={iconArrowLeft} className="cap-admin-icon" />,
          group: "Settings",
        },
        {
          id: "/settings",
          label: "Overview",
          href: "/settings",
          icon: <Icon d={iconOverview} className="cap-admin-icon" />,
          group: "Settings",
          current: pathname === "/settings",
        },
        ...SETTINGS_NAV_GROUPS.flatMap((g) =>
          g.items.map(({ to, label, icon: name }) => ({
            id: to,
            label,
            href: to,
            group: g.label,
            icon: <Icon d={name} className="cap-admin-icon" />,
            current: isSettingsItemActive(pathname, to),
          })),
        ),
      ]
    : pages.map((l) => ({
        id: l.to,
        label: l.label,
        href: l.to,
        group: activeProduct.label,
        icon: icon(l.to),
        current: l === currentPage,
      }));

  // The page bar's name: the page you are on, said once. A page that sits under
  // a menu row without being that row's page (one dispute, under Disputes)
  // names itself in its route's handle.page.
  const platformPage = currentRow(pathname, PLATFORM_LINKS);
  const pageName =
    routePageName(useMatches()) ??
    (currentPage
      ? currentPage.label === "Overview"
        ? `${activeProduct.label} overview`
        : currentPage.label
      : nav.isPlatformPage
        ? (platformPage?.label ?? "Foxhound")
        : activeProduct.label);

  // The phone's bottom bar keeps the tabs the app had, every product then
  // Billing and Settings, up to Capsomer's five (no More: the menu button opens
  // the full list). With Intelligence that is the four products and Settings;
  // Billing is in the avatar menu and the sheet.
  const tabLinks: Array<ProductNavLink & { product?: ProductKey }> = [
    ...PRODUCT_ORDER.map((key) => ({
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
    ? currentRow(
        pathname,
        tabLinks.filter((l) => !l.product),
      )
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

  // The switchers: the business, then the product. In the demo the business
  // switcher lists the demo businesses (Teamflow, Bolt Analytics) and posts to
  // the demo's own switch, as legacy's SiteNav.tsx passed
  // switchAccountUrl="/api/demo/switch-account" when isDemo.
  const business =
    accounts.length > 0
      ? businessSwitcher(
          accounts,
          activeAccountId,
          isDemo ? DEMO_ACCOUNT_SWITCH_URL : ACCOUNT_SWITCH_URL,
        )
      : null;
  const products: HeaderSwitcher = {
    id: "products",
    label: activeProduct.label,
    name: `Product: ${activeProduct.label}`,
    sheetLabel: "Products",
    groups: [
      {
        label: "Products",
        links: PRODUCT_ORDER.map((key) => ({
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
        // The app's name, for the logo and the phone sheet's heading
        // ("Foxhound menu"). The browser title stays each route's own meta
        // title ("Dispute detail - Foxhound"), so the shell never writes it.
        title="Foxhound"
        documentTitle={false}
        nav={menu}
        navLabel={activeProduct.label}
        tabs={tabs}
        page={pageName}
        prefKey="foxhound-app"
        logo={headerLogo("/")}
        band="dark"
        switchers={business ? [business, products] : [products]}
        themePrefKey={THEME_PREF_KEY}
        {...themeMemory("account", theme)}
        renderLink={renderHeaderLink}
        updated={{ at: readAt }}
        status={
          <>
            <span className="fh-app-page-name">{pageName}</span>
            {isDemo ? (
              <span className="fh-demo-badge fh-mono fh-tiny fh-semibold fh-brand fh-caps">
                Demo
              </span>
            ) : null}
          </>
        }
        onHelp={() => void navigate("/help")}
        account={{
          name: userName || email,
          initials: initials(userName, email),
          email: userName ? email : undefined,
          appLabel: accountName ?? email,
          appLinks: [
            ...accountRows.map((l) => ({
              label: l.label,
              href: l.to,
              current: l === currentAccountRow,
            })),
            ...(isAdmin ? [{ label: "Admin", href: "/admin" }] : []),
          ],
          // A plain form post, so sign-out works before the page hydrates.
          signOutAction: "/logout",
        }}
      >
        {/* The demo band and the admin's read-only "View as merchant" band
            (Recova's "Impersonating: {email}" with "Stop impersonating"), at
            the top of the page under the page bar, in Capsomer's mode banner
            and its words: the header stays the first element on the page in
            every state, so the wordmark never moves. Recova's demo header
            carried Connect Stripe (to /signup) on every demo page; a visitor
            without an account gets it, with Exit demo second. A signed-in
            merchant already has an account, so they get Exit only. Stop is a
            plain link: it leaves the app for /admin, behind Access. */}
        {isDemo ? (
          <ModeBanner
            mode="demo"
            signedIn={demoSignedIn}
            actions={
              <>
                {demoSignedIn ? null : (
                  <ButtonLink href="/signup" variant="primary" size="sm">
                    Connect Stripe
                  </ButtonLink>
                )}
                <ButtonLink href="/demo/exit" size="sm">
                  {demoSignedIn ? "Exit demo, return to your account" : "Exit demo"}
                </ButtonLink>
              </>
            }
          />
        ) : null}
        {viewingAs ? (
          <ModeBanner
            mode="view-as"
            who={accountName ?? "this merchant"}
            stopHref={viewingAs.stopHref}
          />
        ) : null}
        {/* Ruling 146: exactly one <main> on every app page. It is the shell's
            own (AdminShell's main region, #cap-main, the skip link's target),
            and the page renders inside it. Legacy replaces the SEGMENT's
            content with its splash and keeps the layout chrome mounted, so the
            header, menu and footer stay put and only the page swaps. The
            footer stays below the page, as legacy's SiteFooter is a sibling of
            the page content. */}
        <div className="fh-app-page">
          {splash ? <RouteSplash mark={{ src: "/icon-512.png", alt: "Foxhound" }} /> : <Outlet />}
        </div>
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
// context this layout already resolved. Renders a minimal,
// self-contained header (no loaderData dependency) since a child-route
// error still leaves this layout's OWN loader's success ambiguous depending
// on where in the tree the error surfaced. Same message-selection logic as
// root.tsx, so a thrown data(message, {status}) still reads as its own
// message rather than a generic HTTP reason phrase.
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  // The header's theme button still saves where the layout's did.
  const rootTheme = useRouteLoaderData<typeof rootLoader>("root")?.theme ?? DEFAULT_THEME;

  // Capsomer's error page (its failed Empty), as the root boundary draws it (app/root.tsx), under the shell's header.
  return (
    <div className="fh-cap fh-error-page" data-cap-site="foxhound" data-family="amber">
      <ErrorPage
        error={error}
        home="/console"
        homeLabel="Back to Foxhound"
        text={errorDetails(error, import.meta.env.DEV)}
        siteHeader={
          <div className="fh-site-header">
            <SiteHeader
              logo={headerLogo("/")}
              themePrefKey={THEME_PREF_KEY}
              {...themeMemory("account", rootTheme)}
              sheetTitle="Foxhound menu"
              renderLink={renderHeaderLink}
            />
          </div>
        }
        dev={import.meta.env.DEV}
      />
    </div>
  );
}
