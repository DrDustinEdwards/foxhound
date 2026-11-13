import { useState } from "react";
import { useLocation } from "react-router";
import { Link } from "capsomer/react/link";

import { Wordmark } from "./wordmark";

// Rebuilt against legacy components/SiteFooter.tsx source (M2, parity
// campaign). The prior version was a four-column grid that had drifted from
// legacy on structure, tokens, link set and behavior alike.
//
// Legacy's column set is exact and is NOT a place to add pages: Product holds
// the four marketing product pages, Explore holds Pricing/Demos/Features,
// Resources holds Docs/Blog (plus Contact, so the support address is one
// click from every marketing page: parity audit 2026-11-10), Legal holds
// Privacy/Terms. /compare,
// /decline-codes and /about were Foxhound additions that ruling 56 forbids
// from landing on a ported surface without a ruling, so they are removed here
// and tracked in the ledger's ruling 56 leak audit.
//
// ONE legacy element is still deliberately absent: the three social icons,
// which stay out until Foxhound handles exist (DEFECT-OPEN, external
// dependency). The bottom row keeps legacy's justify-between shape so they
// drop straight into the right slot.
//
// The MCP line's ruling-8 gate is DISCHARGED and the line is restored (394
// halt 2). The gate was conditional on MCP shipping, and it has: workers/app.ts
// mounts /mcp, `verifyMcpToken` resolves an account from a bearer key, the
// merchant tool registry is live, and S29 issues the keys. A gate whose
// condition is met and which nobody moved is a block held past its own terms,
// so this is a fix TOWARD legacy rather than a Foxhound addition.

/**
 * Legacy's MCP line, verbatim. Exported so the copy is assertable by test, the
 * same reason help.tsx exports SECTIONS.
 */
const MCP_LINE = "Connect via MCP from any AI client";

export const COLUMNS: { heading: string; links: { to: string; label: string }[] }[] = [
  {
    heading: "Product",
    links: [
      // Legacy points Audit at the marketing product page, not at the
      // estimator; this used to link /audit, which is a different page.
      // All four become /product/* when ruling 55's rename lands.
      { to: "/product/audit", label: "Audit" },
      { to: "/product/recovery", label: "Recovery" },
      { to: "/product/disputes", label: "Disputes" },
      { to: "/product/intelligence", label: "Intelligence" },
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
      { to: "/contact", label: "Contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { to: "/privacy", label: "Privacy" },
      { to: "/terms", label: "Terms" },
      { to: "/security", label: "Security" },
      { to: "/accessibility", label: "Accessibility" },
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
      <h2 className="fh-footer-title fh-mono">{heading}</h2>
      <ul className="fh-footer-list">
        {links.map((link) => {
          const isActive = pathname === link.to;
          return (
            <li key={link.to}>
              <Link
                to={link.to}
                aria-current={isActive ? "page" : undefined}
                className={isActive ? "fh-footer-link fh-footer-current" : "fh-footer-link"}
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

// Legacy runs ONE footer component across three variants and switches only what
// sits ABOVE the bottom row (components/SiteFooter.tsx): marketing adds the
// four-column link grid, auth adds Privacy and Terms into the bottom row, and
// app is the bottom row alone. Porting the same shape rather than a second
// component keeps the two surfaces from drifting, which is the whole reason
// legacy built it this way.
//
// The "auth" variant is Recova's for the four sign-in pages (app/layouts/auth.tsx,
// row A1, ruling 403): the bottom row alone, with Privacy and Terms after the
// mark and the copyright, "so visitors can review the legal pages before
// creating an account" (Recova's app/(auth)/layout.tsx). Recova's links are
// mono at the copyright's size and secondary; amber on hover, and 24px
// tall as targets.
export type FooterVariant = "marketing" | "app" | "auth";

const AUTH_LEGAL_LINKS = [
  { to: "/privacy", label: "Privacy" },
  { to: "/terms", label: "Terms" },
];

export function Footer({ variant = "marketing" }: { variant?: FooterVariant } = {}) {
  // Read once per mount, as Foxing's page-shell does: the year is impure, so it must not run on every render.
  const [year] = useState(() => new Date().getFullYear());
  const { pathname } = useLocation();
  const hasColumnsAbove = variant === "marketing";

  return (
    <footer className="fh-footer-footer">
      <div className="fh-footer-wrap">
        {hasColumnsAbove ? (
          // A nav, as Capsomer's family footer groups its links: the link system draws no hover
          // tint behind a link in a nav (capsomer/links.css), and no footer link has one.
          <nav aria-label="Footer" className="fh-footer-grid">
            {/* Wordmark column. The brand mark itself is reserved for the
                bottom row, matching legacy: this column is the wordmark only. */}
            <div>
              <Link to="/" className="fh-footer-home">
                <Wordmark tone="chrome" />
              </Link>
              <p className="fh-footer-text fh-relaxed">The recovery layer for Stripe merchants.</p>
              {/* Legacy's own line and legacy's own treatment, read from
                  components/SiteFooter.tsx: a plain <p> under the blurb, not a
                  link, mt-3 font-mono at 0.6875rem on chrome-text-secondary. */}
              <p className="fh-footer-text-2 fh-mono">{MCP_LINE}</p>
            </div>
            <div className="fh-footer-grid-2">
              {COLUMNS.map((col) => (
                <LinkColumn
                  key={col.heading}
                  heading={col.heading}
                  links={col.links}
                  pathname={pathname}
                />
              ))}
            </div>
          </nav>
        ) : null}

        {/* The inner border separates the column grid from the row, so it is
            legacy's and only appears when something sits above. On the app
            variant the footer's own border-t already separates it from page
            content, and an inner rule would read as a stray line. */}
        <div className={hasColumnsAbove ? "fh-footer-bar fh-footer-bar-ruled" : "fh-footer-bar"}>
          <div className="fh-footer-row">
            <div className="fh-footer-row-2">
              <img
                src="/favicon.svg"
                alt=""
                width={28}
                height={28}
                loading="lazy"
                decoding="async"
                className="fh-footer-block"
                aria-hidden
              />
              <span className="fh-footer-label fh-mono">© {year} Foxhound.</span>
            </div>
            {variant === "auth" ? (
              <nav aria-label="Legal" className="fh-footer-row-3">
                {AUTH_LEGAL_LINKS.map((link) => (
                  <Link key={link.to} to={link.to} className="fh-footer-link-2 fh-mono fh-tiny">
                    {link.label}
                  </Link>
                ))}
              </nav>
            ) : null}
          </div>
          {/* Legacy's bottom row carries three social links here on EVERY
              variant, including app. They stay out under ruling 10 until
              Foxhound handles exist; linking the recovamrr handles is banned.
              The empty flex slot preserves legacy's justify-between shape so
              they drop straight in. */}
          <div className="fh-footer-row-3" />
        </div>
      </div>
    </footer>
  );
}
