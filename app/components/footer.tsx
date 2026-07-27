import { Link, useLocation } from "react-router";

import { Wordmark } from "./wordmark";

// Rebuilt against legacy components/SiteFooter.tsx source (M2, parity
// campaign). The prior version was a four-column grid that had drifted from
// legacy on structure, tokens, link set and behavior alike.
//
// Legacy's column set is exact and is NOT a place to add pages: Product holds
// the four marketing product pages, Explore holds Pricing/Demos/Features,
// Resources holds Docs/Blog, Legal holds Privacy/Terms. /compare,
// /decline-codes and /about were Foxhound additions that ruling 56 forbids
// from landing on a ported surface without a ruling, so they are removed here
// and tracked in the ledger's ruling 56 leak audit.
//
// Two legacy elements are deliberately absent, both by ruling:
//   - the "Connect via MCP from any AI client" line, which stays out until
//     MCP ships (ruling 8, promise-ahead-of-product);
//   - the three social icons, which stay out until Foxhound handles exist
//     (DEFECT-OPEN, external dependency). The bottom row keeps legacy's
//     justify-between shape so they drop straight into the right slot.
export const COLUMNS: { heading: string; links: { to: string; label: string }[] }[] = [
  {
    heading: "Product",
    links: [
      // Legacy points Audit at the marketing product page, not at the
      // estimator; this used to link /audit, which is a different page.
      // All four become /product/* when ruling 55's rename lands.
      { to: "/products/audit", label: "Audit" },
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
    ],
  },
  {
    heading: "Resources",
    links: [
      { to: "/docs", label: "Docs" },
      { to: "/blog", label: "Blog" },
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

// Legacy compares the pathname to the href with STRICT equality, so a footer
// link highlights only on its own page and never on a child route. Legacy
// needed a client wrapper (SiteFooterActiveLinks) reading usePathname to get
// this at all, because its layout was a Server Component; useLocation is the
// direct equivalent here and needs no wrapper.
function LinkColumn({
  heading,
  links,
  pathname,
}: {
  heading: string;
  links: { to: string; label: string }[];
  pathname: string;
}) {
  return (
    <div>
      <h3 className="m-0 mb-3 font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-chrome-text-secondary">
        {heading}
      </h3>
      <ul className="m-0 list-none space-y-2 p-0">
        {links.map((link) => {
          const isActive = pathname === link.to;
          return (
            <li key={link.to}>
              <Link
                to={link.to}
                aria-current={isActive ? "page" : undefined}
                className={`text-[0.875rem] no-underline transition-colors ${
                  isActive ? "text-amber" : "text-chrome-text hover:text-amber"
                }`}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Footer() {
  const { pathname } = useLocation();

  return (
    <footer className="border-t border-border bg-chrome">
      <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
        <div className="grid grid-cols-1 gap-10 py-12 sm:grid-cols-4 lg:grid-cols-5">
          {/* Wordmark column. The brand mark itself is reserved for the
              bottom row, matching legacy: this column is the wordmark only. */}
          <div>
            <Link to="/" className="no-underline">
              <Wordmark tone="chrome" />
            </Link>
            <p className="mt-3 max-w-[240px] text-[0.875rem] leading-relaxed text-chrome-text-secondary">
              The recovery layer for Stripe merchants.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-6 sm:col-span-3 lg:col-span-4 lg:grid-cols-4">
            {COLUMNS.map((col) => (
              <LinkColumn key={col.heading} heading={col.heading} links={col.links} pathname={pathname} />
            ))}
          </div>
        </div>

        <div className="flex h-14 items-center justify-between border-t border-border">
          <div className="flex items-center gap-2.5">
            <img src="/favicon.svg" alt="" width={28} height={28} className="shrink-0" aria-hidden />
            <span className="font-mono text-[0.6875rem] text-chrome-text-secondary">
              © 2026 Foxhound
            </span>
          </div>
          {/* Social icons land here when Foxhound handles exist. */}
          <div className="flex items-center gap-4" />
        </div>
      </div>
    </footer>
  );
}
