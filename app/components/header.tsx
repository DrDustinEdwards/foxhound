import { useState } from "react";
import { Link, NavLink } from "react-router";
import { Menu, X } from "lucide-react";

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

// Legacy parity port (TASK-foxhound-marketing-nav-parity.md): Phase 6 built
// this as a fresh minimal nav from ROUTES.md instead of porting the legacy
// design (the prior in-file comment said so explicitly). Matches
// recova-eta.vercel.app's header: chrome surface, dark in both modes
// (DESIGN.md: "nav/footer/mobile bar stay dark in both modes", matching the
// app-shell header and the footer), compact h-14-equivalent density, and
// the same link set adapted to Foxhound's real routes - Features omitted
// (no /features route exists here, and none should be invented), About
// stays footer-only as legacy had it, Demos included (the acquisition
// surface). Product-aware for authenticated visitors (task Part 2 rule 4):
// a signed-in visitor gets a Dashboard link instead of Sign in/Free audit,
// on this same shared marketing shell (DESIGN.md: "no visual seam at
// login").
export function Header({ isAuthenticated, theme }: { isAuthenticated: boolean; theme: Theme }) {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-chrome">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-8">
        <Link to="/" aria-label="Foxhound home" onClick={() => setOpen(false)}>
          <Wordmark tone="chrome" />
        </Link>

        <nav className="hidden items-center gap-6 sm:flex">
          {NAV_LINKS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `text-label ${isActive ? "text-chrome-text" : "text-chrome-text-secondary"} hover:text-chrome-text`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-3 sm:flex">
          <ThemeToggle initialTheme={theme} variant="chrome" />
          {isAuthenticated ? (
            <Link
              to="/dashboard"
              className="rounded-md bg-amber px-4 py-2 text-label font-medium text-on-amber hover:bg-amber-dark"
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link to="/login" className="text-label text-chrome-text-secondary hover:text-chrome-text">
                Sign in
              </Link>
              <Link
                to="/audit"
                className="rounded-md bg-amber px-4 py-2 text-label font-medium text-on-amber hover:bg-amber-dark"
              >
                Free audit
              </Link>
            </>
          )}
        </div>

        <div className="flex items-center gap-1 sm:hidden">
          <ThemeToggle initialTheme={theme} variant="chrome" />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Toggle menu"
            className="flex items-center justify-center rounded-md border border-border p-2 text-chrome-text"
          >
            {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
          </button>
        </div>
      </div>

      {open ? (
        <nav className="flex flex-col gap-1 border-t border-border-sub px-4 py-3 sm:hidden">
          {NAV_LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-2 text-body text-chrome-text-secondary hover:bg-white/10 hover:text-chrome-text"
            >
              {item.label}
            </Link>
          ))}
          <div className="mt-2 flex flex-col gap-2 border-t border-border-sub pt-3">
            {isAuthenticated ? (
              <Link
                to="/dashboard"
                onClick={() => setOpen(false)}
                className="rounded-md bg-amber px-4 py-2 text-center text-body font-medium text-on-amber"
              >
                Dashboard
              </Link>
            ) : (
              <>
                <Link
                  to="/login"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2 py-2 text-body text-chrome-text-secondary"
                >
                  Sign in
                </Link>
                <Link
                  to="/audit"
                  onClick={() => setOpen(false)}
                  className="rounded-md bg-amber px-4 py-2 text-center text-body font-medium text-on-amber"
                >
                  Free audit
                </Link>
              </>
            )}
          </div>
        </nav>
      ) : null}
    </header>
  );
}
