import { Link } from "react-router";

import { Wordmark } from "./wordmark";

// Legacy parity port (TASK-foxhound-marketing-nav-parity.md): rebuilt to
// recova-eta.vercel.app's four-column structure (Product/Explore/Resources/
// Legal), adapted to Foxhound's real routes - every href below verified
// against app/routes.ts before writing (all four product pages, /compare,
// and /decline-codes exist for real, so none of these are placeholder
// anchors). No social icons yet: legacy's are Recova-branded handles
// (x.com/recovamrr, bsky.app/profile/recovamrr.bsky.social,
// reddit.com/user/recovamrr) with no Foxhound equivalent to swap in; add
// them once Foxhound's own handles exist.
export const COLUMNS: { heading: string; links: { to: string; label: string }[] }[] = [
  {
    heading: "Product",
    links: [
      { to: "/audit", label: "Audit" },
      { to: "/products/recovery", label: "Recovery" },
      { to: "/products/disputes", label: "Disputes" },
      { to: "/products/intelligence", label: "Intelligence" },
    ],
  },
  {
    heading: "Explore",
    links: [
      { to: "/pricing", label: "Pricing" },
      { to: "/demos", label: "Demos" },
      { to: "/features", label: "Features" },
      { to: "/compare", label: "Compare" },
      { to: "/decline-codes", label: "Decline codes" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { to: "/docs", label: "Docs" },
      { to: "/blog", label: "Blog" },
      { to: "/about", label: "About" },
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
    <footer className="border-t border-border-sub bg-chrome">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-12 sm:flex-row sm:justify-between sm:px-8">
        <div className="flex max-w-xs flex-col gap-3">
          <Wordmark tone="chrome" />
          <p className="text-label text-chrome-text-secondary">
            Pay-on-lift recovery, review-and-sign disputes, and free MRR intelligence for Stripe
            merchants.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-2">
              <p className="font-mono text-micro uppercase tracking-wide text-chrome-text-tertiary">
                {col.heading}
              </p>
              {col.links.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className="text-label text-chrome-text-secondary hover:text-chrome-text"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-border-sub px-4 py-6 text-center font-mono text-micro text-chrome-text-tertiary sm:px-8">
        © 2026 Foxhound. All rights reserved.
      </div>
    </footer>
  );
}
