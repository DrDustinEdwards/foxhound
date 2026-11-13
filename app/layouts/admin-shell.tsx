import { PRIVATE_PAGE_HEADERS } from "@dustinedwards/site-runtime/edge-cache";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useMatches, useNavigate, useRouteLoaderData } from "react-router";
import {
  Icon,
  iconActivity,
  iconBrake,
  iconBug,
  iconClock,
  iconListChecks,
  iconOverview,
  iconPeople,
  iconScroll,
  iconStore,
  iconWebhook,
} from "capsomer/react/icons";
import {
  AdminShell,
  FAMILY_APPS,
  type AdminApp,
  type AdminEntry,
} from "capsomer/react/admin-shell";
import { initialsOf } from "capsomer/react/site-header";
import { refuseCrossSite } from "@dustinedwards/site-runtime/origin";

import "~/admin.css";
import { HoundMark } from "~/components/hound-mark";
import { renderHeaderLink, THEME_PREF_KEY, themeMemory } from "~/components/site-header";
import { adminContext } from "~/lib/admin/context";
import { adminPageName } from "~/lib/admin/page";
import { accessAdmin } from "@dustinedwards/site-runtime/access";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { useReadAt } from "~/lib/use-read-at";
import { DEFAULT_THEME, type Theme } from "~/lib/theme";
import { noindexHeader } from "~/lib/seo/meta";

import type { Route } from "./+types/admin-shell";
import type { loader as rootLoader } from "~/root";

// Hydrates: this page has client logic (root.tsx renders <Scripts/> only for a route that says so).
export const handle = { hydrate: true };

// The ONE gate for /admin. Cloudflare Access signs the person in before a
// request reaches the Worker; this re-verifies Access's JWT and the
// ADMIN_EMAIL and CO_OWNER_EMAILS roster (site-runtime accessAdmin), so a request that got
// round Access, or an Access setup that is wrong, never reaches an admin loader
// or action. Anything else gets a 404, as before, so /admin's existence is not
// disclosed. /admin no longer sits under the merchant app shell: no Better Auth
// session, no account, no demo cookie are involved.
// Drawn for one reader and kept out of Web Analytics (site-runtime PRIVATE_PAGE_HEADERS); the children inherit it.
export const headers = () => PRIVATE_PAGE_HEADERS;

export const middleware: Route.MiddlewareFunction[] = [
  noindexHeader,
  async ({ request, context }, next) => {
    const { env } = context.get(cloudflareContext);
    const session = await accessAdmin(request, env);
    if (!session) throw new Response("Not Found", { status: 404 });
    // ONLY THIS ORIGIN MAY WRITE. Access's CF_Authorization cookie rides along
    // on a POST from any site the admin has open, so every admin action (the
    // brake, merchant pauses, staged confirms, crons) would otherwise run on a
    // cross-site form. Checked after the session, so the 404 still hides
    // /admin from everyone else. site-runtime's shared check: a write whose
    // Origin is another site (or "null") gets its 403.
    const refusal = refuseCrossSite(request);
    if (refusal) throw refusal;
    context.set(adminContext, { email: session.email });
    return next();
  },
];

export function loader({ context }: Route.LoaderArgs) {
  return { email: context.get(adminContext).email, readAt: Date.now() };
}

const icon = (d: string) => <Icon d={d} className="cap-admin-icon" />;

// The admin's pages, grouped as the menu shows them. The shell marks the
// current one from the address (its `pathname`, the longest href winning).
// The phone's tab bar takes the first five (Capsomer 0.9.0: no More tab,
// because the header's menu button opens the full list).
const ENTRIES: AdminEntry[] = [
  {
    id: "overview",
    label: "Overview",
    href: "/admin",
    icon: icon(iconOverview),
    // Only /admin itself: an address below it marks its own entry or none.
    match: [/^\/admin$/],
  },
  {
    id: "merchants",
    label: "Merchants",
    href: "/admin/merchants",
    group: "Customers",
    icon: icon(iconStore),
  },
  {
    id: "users",
    label: "Users",
    href: "/admin/users",
    group: "Customers",
    icon: icon(iconPeople),
  },
  {
    id: "operations",
    label: "Operations",
    href: "/admin/operations",
    group: "Platform",
    icon: icon(iconActivity),
  },
  {
    id: "crons",
    label: "Crons",
    href: "/admin/platform/crons",
    group: "Platform",
    icon: icon(iconClock),
  },
  {
    id: "errors",
    label: "Errors",
    href: "/admin/platform/errors",
    group: "Platform",
    icon: icon(iconBug),
  },
  {
    id: "webhooks",
    label: "Webhooks",
    href: "/admin/platform/webhooks",
    group: "Platform",
    icon: icon(iconWebhook),
  },
  {
    id: "brake",
    label: "Emergency brake",
    href: "/admin/brake",
    group: "Controls",
    icon: icon(iconBrake),
  },
  {
    id: "staged",
    label: "Staged changes",
    href: "/admin/staged",
    group: "Controls",
    icon: icon(iconListChecks),
  },
  {
    id: "audit-log",
    label: "Audit log",
    href: "/admin/platform/audit-log",
    group: "Records",
    icon: icon(iconScroll),
  },
];

// The family strip as Capsomer draws it, with Foxhound's own mark in its place.
// Capsomer's strip still draws the x for Foxhound until Dustin picks the real
// logo (capsomer #65 item 15); here Foxhound shows its PLACEHOLDER hound head
// (app/lib/brand/hound-mark.ts) meanwhile. Every other app keeps Capsomer's mark.
const STRIP_APPS: AdminApp[] = FAMILY_APPS.map(({ id, label, href, logo }) => ({
  id,
  label,
  href,
  logo: id === "foxhound" ? <HoundMark className="cap-admin-logo" /> : logo,
  current: id === "foxhound",
}));

// Capsomer's tokens are keyed on data-cap-theme. It follows the site's own
// theme, which the root loader already resolved for <html data-theme>, so the
// server render has the right palette and nothing flashes. The header's theme
// button sets <html data-theme>, saves the choice to Foxhound's fh_theme cookie
// (themeMemory) and announces a "cap-theme" event; this keeps the admin's
// palette in step with it.
function useAdminTheme(): { served: Theme; showing: Theme } {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const initial = rootData?.theme ?? DEFAULT_THEME;
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    const onTheme = (e: Event) => {
      const choice = (e as CustomEvent<{ choice?: string }>).detail?.choice;
      if (choice === "light" || choice === "dark") setTheme(choice);
    };
    document.addEventListener("cap-theme", onTheme);
    return () => document.removeEventListener("cap-theme", onTheme);
  }, []);
  return { served: initial, showing: theme };
}

export default function AdminShellLayout({ loaderData }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const matches = useMatches();
  const navigate = useNavigate();
  const { served, showing: theme } = useAdminTheme();
  const readAt = useReadAt(loaderData.readAt);
  const page = adminPageName(matches) ?? "Foxhound admin";
  const { email } = loaderData;

  // Your admin (Capsomer's owner variant): the strip of the family's apps,
  // Foxhound marked with its PLACEHOLDER hound head (STRIP_APPS), then the
  // grouped menu. The header is the family letterhead: the mark and names, the
  // theme button and the avatar menu last. Search and Inbox are left out: the Foxhound admin
  // has no search and no inbox for them to open, and a control that does
  // nothing is worse than none.
  return (
    <div data-cap-theme={theme} data-family="amber" className="fh-admin">
      <AdminShell
        variant="owner"
        app="foxhound"
        // The family letterhead, as dustinedwards.info and Carrel have it, but
        // standalone: "Foxhound Admin" with no "Dustin Edwards" over it and no
        // family stripe, because Foxhound is a commercial app apart from the
        // Dustin Edwards network (Dustin, 2026-10-30).
        letterhead
        title="Foxhound admin"
        // Each admin route's meta title stays the browser title.
        documentTitle={false}
        page={page}
        nav={ENTRIES}
        pathname={pathname}
        apps={STRIP_APPS}
        prefKey="foxhound-admin"
        themePrefKey={THEME_PREF_KEY}
        {...themeMemory("cookie", served)}
        renderLink={renderHeaderLink}
        updated={{ at: readAt }}
        status={<h1 className="fh-admin-page-name">{page}</h1>}
        viewSite="/"
        // /help is a merchant page behind the app shell; the admin has no merchant
        // session, so its Help opens the public docs.
        onHelp={() => void navigate("/docs")}
        account={{
          // The Access login, not the family owner's name: Foxhound stands
          // apart from the Dustin Edwards network.
          name: email,
          initials: initialsOf(null, email),
          role: "Admin",
          // Access owns sign-out: it ends the Access session, then shows its
          // own login.
          accessLogout: true,
        }}
      >
        {/* The one page frame (Capsomer's .cap-admin-page): every admin page
            starts at the same left edge with the same width and padding. No
            page sets its own column (test/admin-review-1011.test.ts). */}
        <div className="cap-admin-page">
          <Outlet />
        </div>
      </AdminShell>
    </div>
  );
}
