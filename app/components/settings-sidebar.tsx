import {
  iconAccount,
  iconBell,
  iconKey,
  iconMail,
  iconMic,
  iconPeople,
  iconPlug,
  iconScanSearch,
  iconShield,
} from "capsomer/react/icons";

// The settings sub-nav. On a settings page the app shell's left menu shows these rows in place of the product's (app/layouts/app-shell.tsx), so the page has one menu, not two side by side. Features is combined into Email, Alerts into Notifications, and Intelligence (no working control) is gone.

interface SettingsNavItem {
  to: string;
  label: string;
  icon: string;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

/** Five groups. `Products` holds Disputes and Audit. */
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: "Recovery",
    items: [
      { to: "/settings/stripe", label: "Stripe connections", icon: iconPlug },
      { to: "/settings/email", label: "Email", icon: iconMail },
      { to: "/settings/brand-voice", label: "Brand voice", icon: iconMic },
    ],
  },
  {
    label: "Products",
    items: [
      { to: "/settings/disputes", label: "Disputes", icon: iconShield },
      { to: "/settings/audit", label: "Audit", icon: iconScanSearch },
    ],
  },
  {
    label: "Notifications",
    items: [{ to: "/settings/notifications", label: "Notifications and alerts", icon: iconBell }],
  },
  {
    label: "Workspace",
    items: [
      { to: "/settings/team", label: "Team", icon: iconPeople },
      { to: "/settings/api-keys", label: "API keys", icon: iconKey },
    ],
  },
  {
    label: "Account",
    items: [{ to: "/settings/account", label: "My account", icon: iconAccount }],
  },
];

/** An item is active on its own path or a child path. */
export function isSettingsItemActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}
