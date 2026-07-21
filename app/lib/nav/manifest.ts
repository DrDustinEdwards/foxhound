// Route manifest as DATA (task Part 2 rule 3): the nav renders from this, and
// test/nav-manifest.test.ts asserts every href/to exists in the real route
// tree (app/routes.ts), so nav and routes cannot silently drift.
//
// Recovery and Disputes are outcome-priced (PRICING.md) with no
// account_products gate on their routes, so both are always available to any
// account with a membership. Intelligence is the one flat-subscription
// product; it is gated at render time by isIntelligenceEntitled
// (app/lib/intelligence/views.server.ts), resolved once per app-shell
// request, not per nav render.
//
// Two intentional deviations from the legacy shape (task: "map to
// Foxhound's REAL routes ... not the legacy paths"): Recovery's legacy
// "Alerts" link had no Foxhound equivalent (settings/alerts was never built
// here) and is replaced with Foxhound's real /recovery sub-routes.
// Intelligence's legacy "Customers" link had no standalone list route in
// ROUTES.md (the customer list IS the /intelligence overview), so it is
// dropped rather than invented.

export type ProductKey = "dashboard" | "recovery" | "disputes" | "intelligence";

export interface ProductNavLink {
  label: string;
  to: string;
  end?: boolean;
}

export interface ProductManifestEntry {
  key: ProductKey;
  label: string;
  href: string;
  links: ProductNavLink[];
}

export const PRODUCT_ORDER: ProductKey[] = ["dashboard", "recovery", "disputes", "intelligence"];

export const PRODUCT_MANIFEST: Record<ProductKey, ProductManifestEntry> = {
  dashboard: { key: "dashboard", label: "Dashboard", href: "/dashboard", links: [] },
  recovery: {
    key: "recovery",
    label: "Recovery",
    href: "/recovery",
    links: [
      { label: "Overview", to: "/recovery", end: true },
      { label: "Payments", to: "/recovery/payments" },
      { label: "Sequences", to: "/recovery/sequences" },
      { label: "Win-back", to: "/recovery/winback" },
      { label: "Expiring cards", to: "/recovery/expiring-cards" },
    ],
  },
  disputes: { key: "disputes", label: "Disputes", href: "/disputes", links: [] },
  intelligence: {
    key: "intelligence",
    label: "Intelligence",
    href: "/intelligence",
    links: [
      { label: "Overview", to: "/intelligence", end: true },
      { label: "Alerts", to: "/intelligence/alerts" },
      { label: "Reports", to: "/intelligence/reports" },
    ],
  },
};

// Utility (non-product) destinations, rendered in the gear dropdown, never
// in the product switcher.
export const PLATFORM_LINKS: ProductNavLink[] = [
  { label: "Billing", to: "/billing" },
  { label: "Settings", to: "/settings" },
  { label: "Team", to: "/settings/team" },
  { label: "Help", to: "/help" },
];

export function isProductKey(value: string | null | undefined): value is ProductKey {
  return value === "dashboard" || value === "recovery" || value === "disputes" || value === "intelligence";
}

/** Which product a URL belongs to, or null for a platform/admin page. */
export function resolveProductFromPath(pathname: string): ProductKey | null {
  for (const key of PRODUCT_ORDER) {
    const href = PRODUCT_MANIFEST[key].href;
    if (pathname === href || pathname.startsWith(`${href}/`)) return key;
  }
  return null;
}
