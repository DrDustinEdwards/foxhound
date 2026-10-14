import { useState } from "react";
import { Outlet, useLocation, useMatches, useNavigate, useRouteLoaderData } from "react-router";
import {
  Activity,
  Clock,
  FileText,
  LayoutDashboard,
  ListChecks,
  OctagonPause,
  ScrollText,
  Share2,
  Store,
  Users,
  Webhook,
} from "lucide-react";
import { AdminShell, FAMILY_APPS, type AdminApp, type AdminEntry } from "capsomer/react/admin-shell";

import "~/admin.css";
import { HoundMark } from "~/components/hound-mark";
import { headerLogo, personInitials, renderHeaderLink, THEME_PREF_KEY, useThemeMemory } from "~/components/site-header";
import { adminContext } from "~/lib/admin/context";
import { adminPageName } from "~/lib/admin/page";
import { getAdminSession } from "~/lib/auth/access.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { useCollapseKey } from "~/lib/use-collapse-key";
import { useReadAt } from "~/lib/use-read-at";
import { DEFAULT_THEME, type Theme } from "~/lib/theme";

import type { Route } from "./+types/admin-shell";
import type { loader as rootLoader } from "~/root";

// The ONE gate for /admin. Cloudflare Access signs the person in before a
// request reaches the Worker; this re-verifies Access's JWT and the
// ADMIN_EMAIL allowlist (app/lib/auth/access.server.ts), so a request that got
// round Access, or an Access setup that is wrong, never reaches an admin loader
// or action. Anything else gets a 404, as before, so /admin's existence is not
// disclosed. /admin no longer sits under the merchant app shell: no Better Auth
// session, no account, no demo cookie are involved.
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request, context }, next) => {
    const { env } = context.get(cloudflareContext);
    const session = await getAdminSession(env, request);
    if (!session) throw new Response("Not Found", { status: 404 });
    context.set(adminContext, { email: session.email });
    return next();
  },
];

export function loader({ context }: Route.LoaderArgs) {
  return { email: context.get(adminContext).email, readAt: Date.now() };
}

const icon = (Icon: typeof LayoutDashboard) => <Icon className="cap-admin-icon" aria-hidden />;

// The admin's pages, grouped as the menu shows them. `match` decides which
// entry is current. The phone's tab bar takes the first five (Capsomer 0.9.0:
// no More tab, because the header's menu button opens the full list).
const ENTRIES: Array<AdminEntry & { match: (path: string) => boolean }> = [
  { id: "overview", label: "Overview", href: "/admin", icon: icon(LayoutDashboard), match: (p) => p === "/admin" },
  { id: "merchants", label: "Merchants", href: "/admin/merchants", group: "Customers", icon: icon(Store), match: (p) => p.startsWith("/admin/merchants") },
  { id: "users", label: "Users", href: "/admin/users", group: "Customers", icon: icon(Users), match: (p) => p.startsWith("/admin/users") },
  { id: "operations", label: "Operations", href: "/admin/operations", group: "Platform", icon: icon(Activity), match: (p) => p.startsWith("/admin/operations") },
  { id: "crons", label: "Crons", href: "/admin/crons", group: "Platform", icon: icon(Clock), match: (p) => p.startsWith("/admin/crons") },
  { id: "webhooks", label: "Webhooks", href: "/admin/webhooks", group: "Platform", icon: icon(Webhook), match: (p) => p.startsWith("/admin/webhooks") },
  { id: "brake", label: "Emergency brake", href: "/admin/brake", group: "Controls", icon: icon(OctagonPause), match: (p) => p.startsWith("/admin/brake") },
  { id: "staged", label: "Staged changes", href: "/admin/staged", group: "Controls", icon: icon(ListChecks), match: (p) => p.startsWith("/admin/staged") },
  { id: "blog", label: "Blog", href: "/admin/blog", group: "Content", icon: icon(FileText), match: (p) => p.startsWith("/admin/blog") },
  { id: "social", label: "Social", href: "/admin/social", group: "Content", icon: icon(Share2), match: (p) => p.startsWith("/admin/social") },
  { id: "audit-log", label: "Audit log", href: "/admin/audit-log", group: "Records", icon: icon(ScrollText), match: (p) => p.startsWith("/admin/audit-log") },
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
// button sets <html data-theme> and announces a "cap-theme" event; this keeps
// the admin's palette and Foxhound's fh_theme cookie in step with it. The
// button's own memory is set to the same answer before it reads it.
function useAdminTheme(): Theme {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const initial = rootData?.theme ?? DEFAULT_THEME;
  const [theme, setTheme] = useState<Theme>(initial);
  useThemeMemory(initial, "cookie", setTheme);
  return theme;
}

export default function AdminShellLayout({ loaderData }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const matches = useMatches();
  const navigate = useNavigate();
  const theme = useAdminTheme();
  const readAt = useReadAt(loaderData.readAt);
  useCollapseKey();
  const nav = ENTRIES.map(({ match, ...entry }) => ({ ...entry, current: match(pathname) }));
  const page = adminPageName(matches) ?? "Foxhound admin";
  const { email } = loaderData;

  // Your admin (Capsomer's owner variant): the strip of the family's apps,
  // Foxhound marked with its PLACEHOLDER hound head (STRIP_APPS), then the
  // grouped menu. The header is the site's own: the wordmark, the theme button
  // and the avatar menu last. Search and Inbox are left out: the Foxhound admin
  // has no search and no inbox for them to open, and a control that does
  // nothing is worse than none.
  return (
    <div data-cap-theme={theme} data-family="teal" className="fh-admin">
      <AdminShell
        variant="owner"
        app="foxhound"
        title="Foxhound admin"
        page={page}
        nav={nav}
        apps={STRIP_APPS}
        prefKey="foxhound-admin"
        logo={headerLogo("/admin")}
        band="dark"
        themePrefKey={THEME_PREF_KEY}
        renderLink={renderHeaderLink}
        updated={{ at: readAt }}
        status={<h1 className="fh-admin-page-name">{page}</h1>}
        viewSite="/"
        // /help is a merchant page behind the app shell; the admin has no merchant
        // session, so its Help opens the public docs.
        onHelp={() => void navigate("/docs")}
        account={{
          name: email,
          initials: personInitials(null, email),
          // Who you are: the email is the name, so the line under it is the
          // role alone.
          role: "Administrator",
          // Access owns sign-out: it ends the Access session, then shows its
          // own login.
          onSignOut: () => {
            window.location.assign("/cdn-cgi/access/logout");
          },
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
