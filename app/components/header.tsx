import { useState } from "react";
import { Link, NavLink } from "react-router";
import { Menu, X } from "lucide-react";

import { Wordmark } from "./wordmark";

const NAV_LINKS = [
  { to: "/pricing", label: "Pricing" },
  { to: "/products", label: "Products" },
  { to: "/about", label: "About" },
  { to: "/blog", label: "Blog" },
  { to: "/docs", label: "Docs" },
];

// Built out from a bare wordmark-only header (Phase 6 Pass 1). Desktop nav
// is a plain link list per ROUTES.md (Products collapses to one link since
// /products is itself an index of the four product pages, avoiding a
// dropdown that would need extra care at 375px). Mobile collapses to a
// hamburger toggle.
export function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-8">
        <Link to="/" aria-label="Foxhound home" onClick={() => setOpen(false)}>
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-6 sm:flex">
          {NAV_LINKS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `text-label ${isActive ? "text-text" : "text-text-secondary"} hover:text-text`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-3 sm:flex">
          <Link to="/login" className="text-label text-text-secondary hover:text-text">
            Sign in
          </Link>
          <Link
            to="/audit"
            className="rounded-md bg-amber px-4 py-2 text-label font-medium text-on-amber hover:bg-amber-dark"
          >
            Run your free audit
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Toggle menu"
          className="flex items-center justify-center rounded-md border border-border p-2 text-text sm:hidden"
        >
          {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
        </button>
      </div>

      {open ? (
        <nav className="flex flex-col gap-1 border-t border-border-sub px-4 py-3 sm:hidden">
          {NAV_LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-2 text-body text-text-secondary hover:bg-surface hover:text-text"
            >
              {item.label}
            </Link>
          ))}
          <div className="mt-2 flex flex-col gap-2 border-t border-border-sub pt-3">
            <Link
              to="/login"
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-2 text-body text-text-secondary"
            >
              Sign in
            </Link>
            <Link
              to="/audit"
              onClick={() => setOpen(false)}
              className="rounded-md bg-amber px-4 py-2 text-center text-body font-medium text-on-amber"
            >
              Run your free audit
            </Link>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
