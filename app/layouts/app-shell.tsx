import { Form, Link, NavLink, Outlet } from "react-router";
import {
  LayoutDashboard,
  LineChart,
  Receipt,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
} from "lucide-react";

import { Wordmark } from "~/components/wordmark";
import { appShellMiddleware } from "~/lib/auth/guards";
import { authContext } from "~/lib/auth/context";

import type { Route } from "./+types/app-shell";

// Server guard for the entire authenticated tree (session + account required).
export const middleware: Route.MiddlewareFunction[] = [appShellMiddleware];

// Header display data, read from the context the guard populated.
export function loader({ context }: Route.LoaderArgs) {
  const auth = context.get(authContext);
  return {
    accountName: auth.membership.accountName,
    email: auth.email,
    isAdmin: auth.isAdmin,
  };
}

// Single-account-per-user by construction (app/lib/auth/account.ts): no account
// switcher. Primary nav is the same set on desktop (a horizontal bar) and mobile
// (a bottom tab bar); paths are disjoint top-level segments so NavLink's default
// (non-`end`) matching keeps a parent tab active under its nested routes.
const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/recovery", label: "Recovery", icon: RefreshCw },
  { to: "/disputes", label: "Disputes", icon: ShieldAlert },
  { to: "/intelligence", label: "Intelligence", icon: LineChart },
  { to: "/billing", label: "Billing", icon: Receipt },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

// The 2px amber bottom border is the ONLY sanctioned amber-on-active state
// (DESIGN.md); active is otherwise text-text + font-semibold. NavLink sets
// aria-current="page" on the active link itself, nothing extra needed here.
function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive
    ? "inline-block border-b-2 border-amber py-3 text-label font-semibold text-text"
    : "inline-block border-b-2 border-transparent py-3 text-label text-text-tertiary hover:text-text";
}

function tabLinkClassName({ isActive }: { isActive: boolean }): string {
  return `flex flex-1 flex-col items-center gap-0.5 py-2 text-micro ${
    isActive ? "text-amber" : "text-text-tertiary"
  }`;
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <Link to="/dashboard" aria-label="Foxhound dashboard">
            <Wordmark />
          </Link>
          <div className="flex items-center gap-4 text-label text-text-tertiary">
            <Link to="/help" className="hover:text-text">
              Help
            </Link>
            {loaderData.isAdmin ? (
              <Link to="/admin" className="hover:text-text">
                Admin
              </Link>
            ) : null}
            <span>{loaderData.accountName ?? loaderData.email}</span>
            <Form method="post" action="/logout">
              <button type="submit" className="text-text-tertiary hover:text-text">
                Sign out
              </button>
            </Form>
          </div>
        </div>

        <nav aria-label="Primary" className="mx-auto hidden max-w-6xl gap-6 px-4 md:flex">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} className={navLinkClassName}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {/* Bottom padding reserves space for the fixed mobile tab bar below (a
          sibling of this container, never a flex body: DESIGN.md, avoids the
          position:fixed breakage on mobile Chrome). */}
      <div className="pb-16 md:pb-0">
        <Outlet />
      </div>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-border bg-surface md:hidden"
      >
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink key={item.to} to={item.to} className={tabLinkClassName}>
              <Icon size={20} aria-hidden="true" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
