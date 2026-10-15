import {
  AlertTriangle,
  Bell,
  CircleUser,
  Key,
  LayoutDashboard,
  Mail,
  Mic,
  Plug,
  ScanSearch,
  Sliders,
  TrendingUp,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router";

// S25's settings sub-nav, ported from legacy's SettingsSidebar
// (blob `e1a283ec`, 4,047 bytes). 336 binding 2 rules the hub and its sub-nav
// the spec and Foxhound's inline cards the rule to remove, superseding ruling
// 57's deferral of the split.
//
// ONE OF LEGACY'S TWELVE ITEMS IS NOT RENDERED, and it is not a treatment
// choice: `/settings/disputes` (S32) does not exist in Foxhound, and a sub-nav
// entry to a route that 404s is a false promise. It is recorded PORTABLE AFTER
// its row. `/settings/intelligence` (S35) shipped with J69. When Disputes
// ships, it is one line here, in the group legacy puts it in, which is why the groups keep
// their legacy shape even where a group has one item today.

export interface SettingsNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

/**
 * Legacy's five groups in legacy's order. `Products` holds Intelligence and
 * Audit; Disputes is the absent target.
 */
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: "Recovery",
    items: [
      { to: "/settings/stripe", label: "Stripe connections", icon: Plug },
      { to: "/settings/email", label: "Email", icon: Mail },
      { to: "/settings/brand-voice", label: "Brand voice", icon: Mic },
      { to: "/settings/features", label: "Features", icon: Sliders },
    ],
  },
  {
    label: "Products",
    items: [
      { to: "/settings/intelligence", label: "Intelligence", icon: TrendingUp },
      { to: "/settings/audit", label: "Audit", icon: ScanSearch },
    ],
  },
  {
    label: "Notifications",
    items: [
      { to: "/settings/notifications", label: "Notifications", icon: Bell },
      { to: "/settings/alerts", label: "Alerts", icon: AlertTriangle },
    ],
  },
  {
    label: "Workspace",
    items: [
      { to: "/settings/team", label: "Team", icon: Users },
      { to: "/settings/api-keys", label: "API keys", icon: Key },
    ],
  },
  {
    label: "Account",
    items: [{ to: "/settings/account", label: "My account", icon: CircleUser }],
  },
];

// THE COLOURS FOLLOW THE THEME (J40). Recova draws this menu in its chrome
// tokens, dark in both themes, because its aside continued its dark nav. Inside
// the Capsomer frame the aside sits on the page's ground beside AdminShell's
// menu (app/layouts/settings.tsx), so the text takes the page's text tokens and
// the current item's edge and the hover take teal (Q11). Group labels are
// Recova's medium-weight sans; the mono they had here was not Recova's.
//
// Capsomer 0.9.0 has no in-page section menu (its Shell and AdminShell menus
// are whole frames), so this stays Foxhound's own element; the gap is named in
// the J40 pull request as a Capsomer job.

/**
 * Legacy's active rule, both halves.
 *
 * OVERVIEW IS EXACT-MATCH, and legacy's own comment says why: `startsWith`
 * would make it permanently active, because every settings route begins with
 * `/settings`. Every other item matches itself or a child path.
 */
export function isSettingsItemActive(pathname: string, to: string): boolean {
  if (to === "/settings") return pathname === "/settings";
  return pathname === to || pathname.startsWith(`${to}/`);
}

function itemClass(active: boolean): string {
  return [
    "flex items-center gap-2 px-3 py-2 text-label no-underline transition-colors duration-150",
    active
      ? "border-l-2 border-brand font-medium text-text"
      : "border-l-2 border-transparent text-text-secondary hover:text-brand-text",
  ].join(" ");
}

export function SettingsSidebar() {
  const pathname = useLocation().pathname;
  const overviewActive = isSettingsItemActive(pathname, "/settings");

  return (
    <nav className="flex flex-col gap-6 overflow-y-auto px-4 py-6" aria-label="Settings navigation">
      <ul className="flex flex-col gap-0.5">
        <li>
          <Link
            to="/settings"
            className={itemClass(overviewActive)}
            aria-current={overviewActive ? "page" : undefined}
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden />
            Overview
          </Link>
        </li>
      </ul>

      {SETTINGS_NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="mb-1 px-3 text-micro font-medium uppercase tracking-widest text-text-tertiary">
            {group.label}
          </p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isSettingsItemActive(pathname, item.to);
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className={itemClass(active)}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
