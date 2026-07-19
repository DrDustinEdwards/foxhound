import { Link } from "react-router";

import { Wordmark } from "./wordmark";

// NEW in Phase 6 Pass 1 (legacy had SiteFooterActiveLinks; this repo builds
// a plain footer since path-based active-link highlighting is not required
// by ROUTES.md). Carries the required /about link (task: "the required
// /about link lives here").
const COLUMNS: { heading: string; links: { to: string; label: string }[] }[] = [
  {
    heading: "Product",
    links: [
      { to: "/products", label: "Products" },
      { to: "/pricing", label: "Pricing" },
      { to: "/demos", label: "Demos" },
    ],
  },
  {
    heading: "Company",
    links: [
      { to: "/about", label: "About" },
      { to: "/blog", label: "Blog" },
      { to: "/docs", label: "Docs" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { to: "/privacy", label: "Privacy" },
      { to: "/terms", label: "Terms" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border-sub">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-12 sm:flex-row sm:justify-between sm:px-8">
        <div className="flex max-w-xs flex-col gap-3">
          <Wordmark />
          <p className="text-label text-text-tertiary">
            Pay-on-lift recovery, review-and-sign disputes, and free MRR intelligence for Stripe
            merchants.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-2">
              <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                {col.heading}
              </p>
              {col.links.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className="text-label text-text-secondary hover:text-text"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-border-sub px-4 py-6 text-center font-mono text-micro text-text-subtle sm:px-8">
        Foxhound. US company, US jurisdiction.
      </div>
    </footer>
  );
}
