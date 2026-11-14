import { Link } from "capsomer/react/link";
import { initials } from "capsomer/behavior/avatar";
import { type HeaderAccount, type LinkProps } from "capsomer/react/site-header";

import "~/site-header.css";
import { PLATFORM_LINKS } from "~/lib/nav/manifest";
import { THEME_COOKIE, type Theme } from "~/lib/theme";

// What the public site, the merchant app and the admin share in Capsomer's site
// header (capsomer/react/site-header; docs/design/design-site-header.md in
// capsomer, Dustin's answers of 2026-10-13, recorded in
// parity/APPROVED-DIFFERENCES.md): the wordmark, the link renderer, the avatar
// menu that replaced the gear, and where the theme button saves a choice.

/** Where Capsomer's theme button remembers the choice in this browser. */
export const THEME_PREF_KEY = "fh-theme";

// The wordmark lives in its own module so the root error page (error-view.tsx)
// can draw it without pulling this file's CSS and switcher code into every page.
export { headerLogo } from "./header-logo";

// Routes that leave the React Router app (a POST endpoint, Stripe's OAuth hop,
// Cloudflare Access) get a plain anchor and a full document load.
const DOCUMENT_HREF = /^(\/(api|connect|cdn-cgi|demo)(\/|$)|https?:)/;

/** Capsomer's links as React Router's. An account row in the business
 *  switcher is no link: Capsomer draws it as a button (its onClick switches). */
export function renderHeaderLink({ href, children, onClick, ...rest }: LinkProps) {
  if (DOCUMENT_HREF.test(href)) {
    return (
      <a href={href} onClick={onClick} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={href} onClick={onClick} {...rest}>
      {children}
    </Link>
  );
}

function isOn(pathname: string, to: string, end = false): boolean {
  return pathname === to || (!end && pathname.startsWith(`${to}/`));
}

/** The business's rows in the avatar menu, under its name: the design's list
 *  (Dustin's answer 3), each on the route the gear linked to. The gear's other
 *  rows (Notifications, Features, Stripe connections, My account) are each one
 *  row of the Settings hub, so no page loses its way in. */
// Recova's GearMenu rows. Every settings page is in the settings sidebar, so
// the avatar menu stays short (Dustin 2026-10-29: "why is the drop down menu
// so huge").
const BUSINESS_ROW_LABELS = ["Settings", "Billing"] as const;

export function businessRows(hasAccount: boolean) {
  return BUSINESS_ROW_LABELS.flatMap((label) =>
    PLATFORM_LINKS.filter((l) => l.label === label),
  ).filter((l) => !l.requiresAccount || hasAccount);
}

/** The row of `links` for the page you are on: the longest match, so
 *  /settings/team marks Team and not Settings too. */
export function currentRow<T extends { to: string; end?: boolean }>(
  pathname: string,
  links: T[],
): T | undefined {
  return links
    .filter((l) => isOn(pathname, l.to, l.end))
    .sort((a, b) => b.to.length - a.to.length)[0];
}

/** The avatar menu, last in the header, in place of the gear (Dustin's answer
 *  3): who you are; the business's rows under its name (Billing only with an
 *  account, as legacy gated it); then Help, Admin for an admin; Sign out last. */
export function merchantAccountMenu({
  name,
  email,
  businessName,
  hasAccount,
  isAdmin,
  pathname,
  onSignOut,
}: {
  name: string | null;
  email: string;
  businessName: string | null;
  hasAccount: boolean;
  isAdmin: boolean;
  pathname: string;
  onSignOut: () => void;
}): HeaderAccount {
  const rows = businessRows(hasAccount);
  const current = currentRow(pathname, rows);
  return {
    name: name || email,
    initials: initials(name, email),
    detail: name ? email : undefined,
    groups: [
      {
        label: businessName ?? undefined,
        links: rows.map((l) => ({ label: l.label, href: l.to, current: l === current })),
      },
      {
        links: [
          { label: "Help", href: "/help", current: isOn(pathname, "/help") },
          ...(isAdmin ? [{ label: "Admin", href: "/admin" }] : []),
        ],
      },
    ],
    onSignOut,
  };
}

/** The theme as Foxhound keeps it. The server resolves it (an account's stored
 *  choice, else this device's cookie; ruling 59) and <html data-theme> carries
 *  it from the first byte. Capsomer's theme button copies that answer into this
 *  browser's memory before it reads it, and saves every switch where Foxhound
 *  keeps it: an authenticated merchant's to accounts.theme through /api/theme,
 *  so it follows them across devices, anyone else's to the fh_theme cookie.
 *  Exclusive, as in legacy's NavThemeToggle. Fire and forget: the page has
 *  already switched, so a failed write must not switch it back; the next
 *  request reconciles. Spread onto SiteHeader or AdminShell. */
export function themeMemory(save: "account" | "cookie", initial: Theme) {
  return save === "account"
    ? { themeInitial: initial, onThemeSave: saveAccountTheme }
    : { themeInitial: initial, themeCookie: THEME_COOKIE };
}

function saveAccountTheme(theme: Theme): Promise<Response> {
  return fetch("/api/theme", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  });
}
