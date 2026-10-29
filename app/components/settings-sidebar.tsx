import {
  AlertTriangle,
  Bell,
  CircleUser,
  Key,
  Mail,
  Mic,
  Plug,
  ScanSearch,
  Shield,
  Sliders,
  TrendingUp,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// S25's settings sub-nav, ported from legacy's SettingsSidebar. On a settings
// page the app shell's left menu shows these rows in place of the product's
// (app/layouts/app-shell.tsx), so the page has one menu, not two side by side
// (Dustin 2026-10-29).
//
// (blob `e1a283ec`, 4,047 bytes). 336 binding 2 rules the hub and its sub-nav
// the spec and Foxhound's inline cards the rule to remove, superseding ruling
// 57's deferral of the split.
//
// ALL TWELVE OF LEGACY'S ITEMS. `/settings/intelligence` (S35) shipped with
// J69 and `/settings/disputes` (S32) with J06, each one line here in the group
// legacy puts it in, which is why the groups keep their legacy shape.

interface SettingsNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

/**
 * Legacy's five groups in legacy's order. `Products` holds Disputes,
 * Intelligence and Audit.
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
      { to: "/settings/disputes", label: "Disputes", icon: Shield },
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
