import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useMatches, useNavigation, useRouteLoaderData } from "react-router";
import {
  Activity,
  CircleUser,
  Clock,
  FileText,
  LayoutDashboard,
  ListChecks,
  Menu as MenuIcon,
  OctagonPause,
  ScrollText,
  Share2,
  Store,
  Users,
  Webhook,
} from "lucide-react";
import { openSheet } from "capsomer/behaviour/admin-shell";
import { AdminShell, type AdminEntry } from "capsomer/react/admin-shell";
import { ThemeSwitch } from "capsomer/react/theme-switch";
import { Time } from "capsomer/react/time";

import "~/admin.css";
import { adminContext } from "~/lib/admin/context";
import { adminPageName } from "~/lib/admin/page";
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
  return { email: context.get(adminContext).email, readAt: Date.now() };
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
// server render has the right palette and nothing flashes. Capsomer's Light
// and Dark switch sets <html data-theme> and announces a "cap-theme" event;
// this keeps the admin's palette and Foxhound's fh_theme cookie in step with it.
function useAdminTheme(): Theme {
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const [theme, setTheme] = useState<Theme>(rootData?.theme ?? DEFAULT_THEME);
  useEffect(() => {
    const onTheme = (e: Event) => {
      const choice = (e as CustomEvent<{ choice?: string }>).detail?.choice;
      if (choice !== "light" && choice !== "dark") return;
      setTheme(choice);
      document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; SameSite=Lax`;
    };
    document.addEventListener("cap-theme", onTheme);
    return () => document.removeEventListener("cap-theme", onTheme);
  }, []);
  return theme;
}

// When the page's data was last read: the server's time on the first load,
// then each time a navigation, a form or a revalidation finishes (every one
// re-runs the page's loader). The top bar says it in words, so nobody reads
// minutes-old numbers as live.
function useReadAt(serverReadAt: number): number {
  const [readAt, setReadAt] = useState(serverReadAt);
  const navigation = useNavigation();
  const { key } = useLocation();
  const wasBusy = useRef(false);
  useEffect(() => {
    if (navigation.state !== "idle") {
      wasBusy.current = true;
    } else if (wasBusy.current) {
      wasBusy.current = false;
      setReadAt(Date.now());
    }
  }, [navigation.state, key]);
  return readAt;
}

// Phone only: the strip and the menu live in the shell's sheet, so the top bar
// gets the two ways into it, the menu and the account (the sheet's account rows:
// View site, Sign out).
function PhoneControls() {
  const open = (focusAccount: boolean) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const shell = e.currentTarget.closest<HTMLElement>("[data-cap='admin-shell']");
    if (!shell) return;
    openSheet(shell);
    if (focusAccount) {
      shell.querySelector<HTMLElement>(".cap-admin-sheet-account a, .cap-admin-sheet-account button")?.focus();
    }
  };
  return (
    <span className="fh-admin-phone-controls">
      <button type="button" className="fh-admin-icon-btn" aria-label="Menu" onClick={open(false)}>
        <MenuIcon className="cap-admin-icon" aria-hidden />
      </button>
      <button type="button" className="fh-admin-icon-btn" aria-label="Account" onClick={open(true)}>
        <CircleUser className="cap-admin-icon" aria-hidden />
      </button>
    </span>
  );
}

export default function AdminShellLayout({ loaderData }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const matches = useMatches();
  const theme = useAdminTheme();
  const readAt = useReadAt(loaderData.readAt);
  const nav = ENTRIES.map(({ match, ...entry }) => ({ ...entry, current: match(pathname) }));
  const page = adminPageName(matches) ?? "Foxhound admin";
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
        status={
          <span className="fh-admin-bar-page">
            <h1 className="fh-admin-page-name">{page}</h1>
            <span>
              Updated <Time at={readAt} />
            </span>
          </span>
        }
        actions={
          <>
            <ThemeSwitch prefKey="foxhound-admin-theme" initial={theme} />
            <PhoneControls />
          </>
        }
        account={{
          name: email,
          initials: (email[0] ?? "A").toUpperCase(),
          role: "Administrator",
          email,
          appLinks: [{ label: "View site", href: "/" }],
          // Access owns sign-out: it ends the Access session, then shows its
          // own login.
          onSignOut: () => {
            window.location.href = "/cdn-cgi/access/logout";
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
