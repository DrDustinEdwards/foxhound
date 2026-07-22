import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router";
import { Menu, Settings, X } from "lucide-react";

import { Avatar } from "./nav/avatar";
import { SectionPill } from "./nav/section-pill";
import { ThemeToggle } from "./theme-toggle";
import { Wordmark } from "./wordmark";
import type { Theme } from "~/lib/theme";

export const NAV_LINKS = [
  { to: "/products", label: "Products" },
  { to: "/pricing", label: "Pricing" },
  { to: "/demos", label: "Demos" },
  { to: "/docs", label: "Docs" },
  { to: "/blog", label: "Blog" },
];

// Legacy parity port v2 (TASK-foxhound-marketing-header-v2.md): the prior
// pass (TASK-foxhound-marketing-nav-parity.md) fixed surface and link set;
// this fixes STRUCTURE. Read directly off the live legacy header
// (recova-eta.vercel.app, inspected at desktop and mobile widths): full-bleed
// h-14 bar (no max-w-6xl container - legacy's bar IS the full viewport
// width), links right-aligned with an amber-underline hover/active
// treatment, a thin divider before the CTA, and a gear icon that is always
// rendered but dimmed/inert for an anonymous visitor and a live /settings
// link once authenticated.
//
// Nav link classes are legacy's own, verbatim: the after:-pseudo-element
// underline scales from 0 to full width on hover (transform, not width, so
// it is compositor-only) and snaps to full width when NavLink's isActive is
// true, with no separate "current page" affordance beyond that.
const NAV_LINK_BASE =
  "relative pb-px text-[0.8125rem] no-underline transition-colors duration-150 after:absolute after:bottom-0 after:left-0 after:h-[2px] after:w-full after:origin-left after:bg-amber after:transition-transform after:duration-200";
const NAV_LINK_INACTIVE =
  "text-chrome-text-secondary after:scale-x-0 hover:text-chrome-text hover:after:scale-x-100";
const NAV_LINK_ACTIVE = "text-chrome-text after:scale-x-100";

export function Header({
  isAuthenticated,
  theme,
  initial = null,
  intelligenceEntitled = false,
}: {
  isAuthenticated: boolean;
  theme: Theme;
  // Optional: the two standalone public-utility routes outside the
  // marketing layout (card-update.tsx, unsubscribe.tsx) always render
  // Header with isAuthenticated=false and have no session context to
  // resolve these from.
  initial?: string | null;
  intelligenceEntitled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Body scroll lock while the drawer is open (legacy behavior, confirmed
  // live: document.body computed overflow flips to "hidden" while the
  // drawer is open).
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-chrome px-6">
      <div className="flex items-center gap-3">
        <Link to="/" aria-label="Foxhound home" onClick={() => setOpen(false)}>
          <Wordmark tone="chrome" />
        </Link>
        {isAuthenticated ? <SectionPill intelligenceEntitled={intelligenceEntitled} /> : null}
      </div>

      <div className="hidden items-center gap-5 sm:flex">
        {NAV_LINKS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `${NAV_LINK_BASE} ${isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE}`}
          >
            {item.label}
          </NavLink>
        ))}

        {!isAuthenticated ? (
          <>
            <Link to="/login" className={`${NAV_LINK_BASE} ${NAV_LINK_INACTIVE}`}>
              Sign in
            </Link>
            <div className="h-4 w-px bg-border" />
            <Link
              to="/audit"
              className="whitespace-nowrap rounded-md bg-amber px-4 py-2 text-[0.8125rem] font-semibold text-on-amber transition-colors duration-150 hover:bg-amber-dark"
            >
              Free audit
            </Link>
          </>
        ) : null}

        <ThemeToggle initialTheme={theme} variant="chrome" />

        {isAuthenticated ? (
          <Link
            to="/settings"
            aria-label="Settings"
            className="flex h-8 w-8 items-center justify-center rounded-md text-chrome-text-secondary transition-colors duration-150 hover:bg-white/10 hover:text-chrome-text"
          >
            <Settings width={16} height={16} strokeWidth={1.5} aria-hidden />
          </Link>
        ) : (
          <div className="cursor-default p-1.5 opacity-30" aria-hidden="true">
            <Settings width={16} height={16} strokeWidth={1.5} className="text-chrome-text-secondary" />
          </div>
        )}

        {isAuthenticated && initial ? <Avatar initial={initial} /> : null}
      </div>

      <div className="flex items-center gap-2 sm:hidden">
        <ThemeToggle initialTheme={theme} variant="chrome" />
        {!isAuthenticated ? (
          <Link
            to="/login"
            className="px-1 text-[0.8125rem] text-chrome-text-secondary no-underline transition-colors duration-150 hover:text-chrome-text"
          >
            Sign in
          </Link>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
          aria-label="Toggle menu"
          className="flex items-center justify-center rounded-md border border-border p-2 text-chrome-text"
        >
          <Menu size={18} aria-hidden />
        </button>
      </div>

      {/* Legacy-parity slide-in drawer (right, 280px), replacing the prior
          inline dropdown. Overlay + panel both stay mounted (not
          conditionally rendered) so the transform/opacity transitions play
          on both open and close; closed state is also `invisible` so the
          off-screen panel cannot receive keyboard focus. */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-250 sm:hidden ${
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        id="mobile-nav-drawer"
        className={`fixed top-0 right-0 z-50 flex h-full w-[280px] flex-col bg-chrome shadow-lg transition-transform duration-250 ease-out sm:hidden ${
          open ? "visible translate-x-0" : "invisible translate-x-full"
        }`}
      >
        <div className="flex justify-end px-4 pt-4">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="flex items-center justify-center rounded-md border-0 bg-transparent p-1.5 transition-colors duration-150 hover:bg-white/10"
          >
            <X size={20} className="text-chrome-text-secondary" aria-hidden />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pt-6">
          {NAV_LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className="block border-b border-border py-3 text-[0.9375rem] text-chrome-text-secondary no-underline transition-all duration-200 hover:text-chrome-text"
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className="flex flex-col gap-3 border-t border-border px-6 pt-4 pb-8">
          {isAuthenticated ? (
            <Link
              to="/dashboard"
              onClick={() => setOpen(false)}
              className="rounded-md bg-amber px-6 py-3 text-center text-[0.9375rem] font-semibold text-on-amber transition-colors duration-150 hover:bg-amber-dark"
            >
              Dashboard
            </Link>
          ) : (
            <Link
              to="/audit"
              onClick={() => setOpen(false)}
              className="rounded-md bg-amber px-6 py-3 text-center text-[0.9375rem] font-semibold text-on-amber transition-colors duration-150 hover:bg-amber-dark"
            >
              Free audit
            </Link>
          )}
        </div>
      </aside>
    </header>
  );
}
