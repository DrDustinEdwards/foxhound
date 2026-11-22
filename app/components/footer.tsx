import { copyright } from "capsomer/behavior/family-footer";
import { useLocation } from "react-router";
import { Link } from "capsomer/react/link";

import { Wordmark } from "./wordmark";

// /compare, /decline-codes and /about are not in the footer. The three social icons wait for Foxhound handles to exist.
export const COLUMNS: { heading: string; links: { to: string; label: string }[] }[] = [
  {
    heading: "Product",
    links: [
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

// A footer link highlights only on its own page, never on a child route (strict equality of pathname and href).
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
    <div className="cap-stack" data-gap="4">
      <h2 className="cap-label fh-mono">{heading}</h2>
      <ul className="cap-stack" data-gap="3">
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to} aria-current={pathname === link.to ? "page" : undefined}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// One footer, three variants that differ only in what sits above the bottom row: marketing adds
// the link columns, auth adds Privacy and Terms into the bottom row (so visitors can review the
// legal pages before creating an account), app is the bottom row alone. Capsomer's site footer
// draws the band, its hairline and the small print; the columns are the only layout here.
export type FooterVariant = "marketing" | "app" | "auth";

const AUTH_LEGAL_LINKS = [
  { to: "/privacy", label: "Privacy" },
  { to: "/terms", label: "Terms" },
];

export function Footer({ variant = "marketing" }: { variant?: FooterVariant } = {}) {
  const { pathname } = useLocation();

  return (
    <footer className="cap-site-footer fh-footer">
      <div className="cap-page fh-cap">
        {variant === "marketing" ? (
          <nav aria-label="Footer" className="fh-footer-columns">
            <div className="cap-stack" data-gap="4">
              <Link to="/" className="fh-footer-home">
                <Wordmark tone="chrome" />
              </Link>
              <p className="cap-site-footer-note">The recovery layer for Stripe merchants.</p>
            </div>
            {COLUMNS.map((col) => (
              <LinkColumn
                key={col.heading}
                heading={col.heading}
                links={col.links}
                pathname={pathname}
              />
            ))}
          </nav>
        ) : null}

        <div
          className="cap-cluster fh-footer-bar"
          data-align="center"
          data-gap="5"
          data-ruled={variant === "marketing" ? "" : undefined}
        >
          <span className="fh-footer-mark" aria-hidden />
          <span className="cap-site-footer-note fh-mono fh-tiny">{copyright("Foxhound")}.</span>
          {variant === "auth" ? (
            <nav
              aria-label="Legal"
              className="cap-site-footer-links fh-mono fh-tiny"
              data-links="quiet"
            >
              {AUTH_LEGAL_LINKS.map((link) => (
                <Link key={link.to} to={link.to}>
                  {link.label}
                </Link>
              ))}
            </nav>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
