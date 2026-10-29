import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { HeaderAccount, LinkProps } from "capsomer/react/site-header";
import { themeCookie } from "capsomer/theme-server";

import "~/site-header.css";
import { switchAccount, switchTargetFromHref } from "~/components/nav/account-switcher";
import { PLATFORM_LINKS } from "~/lib/nav/manifest";
import { THEME_COOKIE, type Theme } from "~/lib/theme";

// What the public site, the merchant app and the admin share in Capsomer's site
// header (capsomer/react/site-header; docs/design/design-site-header.md in
// capsomer, Dustin's answers of 2026-10-13, recorded in
// parity/APPROVED-DIFFERENCES.md): the wordmark, the link renderer, the avatar
// menu that replaced the gear, and the theme button's memory.

/** Where Capsomer's theme button remembers the choice in this browser. */
export const THEME_PREF_KEY = "fh-theme";

// The wordmark lives in its own module so the root error page (error-view.tsx)
// can draw it without pulling this file's CSS and switcher code into every page.
export { headerLogo } from "./header-logo";

// Routes that leave the React Router app (a POST endpoint, Stripe's OAuth hop,
// Cloudflare Access) get a plain anchor and a full document load.
const DOCUMENT_HREF = /^(\/(api|connect|cdn-cgi|demo)(\/|$)|https?:)/;

/** Capsomer's links as React Router's. An account row in the business
 *  switcher is a POST, not a page: it is drawn as a button that switches. */
export function renderHeaderLink({ href, children, onClick, ...rest }: LinkProps) {
  const switchTo = switchTargetFromHref(href);
  if (switchTo !== null) {
    const isCurrent = Boolean(rest["aria-current"]);
    return (
      <button
        type="button"
        data-panel-close=""
        {...rest}
        onClick={() => {
          onClick?.();
          if (!isCurrent) void switchAccount(switchTo.accountId, switchTo.switchAccountUrl);
        }}
      >
        {children}
      </button>
    );
  }
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

/** The two letters on the avatar: the person's initials, else their email's
 *  first letter. */
export function personInitials(name: string | null | undefined, email: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (email[0] ?? "?").toUpperCase();
}

function isOn(pathname: string, to: string, end = false): boolean {
  return pathname === to || (!end && pathname.startsWith(`${to}/`));
}

/** The business's rows in the avatar menu, under its name: the design's list
 *  (Dustin's answer 3), each on the route the gear linked to. The gear's other
 *  rows (Notifications, Features, Stripe connections, My account) are each one
 *  row of the Settings hub, so no page loses its way in. */
const BUSINESS_ROW_LABELS = [
  "Settings",
  "Billing",
  "Team",
  "Audit settings",
  "Audit history",
  "Email settings",
  "Alerts",
  "API keys",
  "Brand voice",
] as const;

export function businessRows(hasAccount: boolean) {
  return BUSINESS_ROW_LABELS.flatMap((label) => PLATFORM_LINKS.filter((l) => l.label === label)).filter(
    (l) => !l.requiresAccount || hasAccount,
  );
}

/** The row of `links` for the page you are on: the longest match, so
 *  /settings/team marks Team and not Settings too. */
export function currentRow<T extends { to: string; end?: boolean }>(pathname: string, links: T[]): T | undefined {
  return links.filter((l) => isOn(pathname, l.to, l.end)).sort((a, b) => b.to.length - a.to.length)[0];
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
    initials: personInitials(name, email),
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
 *  it from the first byte. Capsomer's theme button also remembers a choice in
 *  this browser, so that memory is set to the server's answer before the button
 *  reads it, and every switch is saved where Foxhound keeps it: an
 *  authenticated merchant's to accounts.theme, so it follows them across
 *  devices, anyone else's to the cookie. Exclusive, as in legacy's
 *  NavThemeToggle. Fire-and-forget: the page has already switched, so a failed
 *  write must not switch it back; the next request reconciles. */
export function useThemeMemory(serverTheme: Theme, save: "account" | "cookie", onChange?: (theme: Theme) => void): void {
  useState(() => {
    if (typeof window === "undefined") return null;
    try {
      localStorage.setItem(THEME_PREF_KEY, serverTheme);
    } catch {
      // Storage blocked: the button falls back to <html data-theme>.
    }
    return null;
  });
  const showing = useRef<Theme>(serverTheme);
  useEffect(() => {
    const onTheme = (e: Event) => {
      const choice = (e as CustomEvent<{ choice?: string }>).detail?.choice;
      if ((choice !== "light" && choice !== "dark") || choice === showing.current) return;
      showing.current = choice;
      onChange?.(choice);
      persistTheme(choice, save);
    };
    document.addEventListener("cap-theme", onTheme);
    return () => document.removeEventListener("cap-theme", onTheme);
  }, [save, onChange]);
}

function persistTheme(theme: Theme, save: "account" | "cookie"): void {
  if (save === "account") {
    void fetch("/api/theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    });
    return;
  }
  document.cookie = themeCookie(theme, { name: THEME_COOKIE, secure: location.protocol === "https:" });
}
