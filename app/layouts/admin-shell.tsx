import { useState } from "react";
import { Link, Outlet, useLocation, useRouteLoaderData } from "react-router";
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
import { AdminShell, type AdminEntry } from "capsomer/react/admin-shell";

import "~/admin.css";
import { adminContext } from "~/lib/admin/context";
import { getAdminSession } from "~/lib/auth/access.server";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { DEFAULT_THEME, THEME_COOKIE, type Theme } from "~/lib/theme";

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
  return { email: context.get(adminContext).email };
}

const icon = (Icon: typeof LayoutDashboard) => <Icon className="cap-admin-icon" aria-hidden />;

// The admin's pages, grouped as the menu shows them. `match` decides which
// entry is current. The phone's tab bar takes the first four; the rest sit
// under More.
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

// Capsomer's tokens are keyed on data-cap-theme. It follows the site's own
// theme, which the root loader already resolved for <html data-theme>, so the
// server render has the right palette and nothing flashes.
function useAdminTheme(): [Theme, () => void] {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const [theme, setTheme] = useState<Theme>(rootData?.theme ?? DEFAULT_THEME);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  };
  return [theme, toggle];
}

export default function AdminShellLayout({ loaderData }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const [theme, toggleTheme] = useAdminTheme();
  const nav = ENTRIES.map(({ match, ...entry }) => ({ ...entry, current: match(pathname) }));
  const { email } = loaderData;

  return (
    <div data-cap-theme={theme} className="fh-admin">
      <AdminShell
        title="Foxhound admin"
        apps={[{ id: "foxhound", label: "Foxhound admin", href: "/admin", mono: "F", current: true }]}
        nav={nav}
        prefKey="foxhound-admin"
        renderLink={({ href, children, ...rest }) => (
          <Link to={href} {...rest}>
            {children}
          </Link>
        )}
        account={{
          name: email,
          initials: (email[0] ?? "A").toUpperCase(),
          role: "Administrator",
          email,
          appLinks: [
            { label: "View site", href: "/" },
            {
              label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
              onClick: toggleTheme,
            },
          ],
          // Access owns sign-out: it ends the Access session, then shows its
          // own login.
          onSignOut: () => {
            window.location.href = "/cdn-cgi/access/logout";
          },
        }}
      >
        <Outlet />
      </AdminShell>
    </div>
  );
}
