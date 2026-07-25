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
// One intentional deviation from the legacy shape (task: "map to Foxhound's
// REAL routes ... not the legacy paths"): Recovery's legacy "Alerts" link had
// no Foxhound equivalent (settings/alerts was never built here) and is
// replaced with Foxhound's real /recovery sub-routes.
//
// Intelligence's "Customers" link (ROUTES.md rev 4, TASK-foxhound-
// intelligence-customer-directory.md): restored once /intelligence/customers
// existed as a real route. Before that it was correctly dropped rather than
// invented; it is not a re-added legacy holdover.

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
      { label: "Customers", to: "/intelligence/customers" },
      { label: "Churn", to: "/intelligence/churn" },
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

// The marketing header's authenticated-only SectionPill menu
// (app/components/nav/section-pill.tsx) is NOT a view of PRODUCT_MANIFEST:
// its item set, order, and labels are legacy ground truth (screenshot,
// 2026-07-22) - Console, Audit, Recovery, Disputes, Intelligence - a
// different shape than the manifest's own Dashboard-first, Audit-less list
// the app-shell ProductSwitcher renders. Kept as its own data list beside
// the manifest (TASK-foxhound-pill-menu-parity.md rule 3) rather than
// mutating PRODUCT_MANIFEST or renaming its keys/labels.
//
// Audit mapping decision: app/routes.ts has no authenticated audit route
// anywhere under the app-shell layout (checked directly: dashboard,
// recovery/*, disputes/*, intelligence/*, billing/*, settings/*, help,
// welcome, admin/* - no audit/*). Legacy's pill linked an in-app audit
// console; Foxhound's audit product currently surfaces only through the
// public, no-auth /audit estimator, so that is where this links. Revisit
// this mapping if/when an authenticated audit surface ships.
export interface MarketingPillItem {
  label: string;
  to: string;
  /** Intelligence only: hidden unless the viewer's account is entitled,
   *  same gate the app-shell ProductSwitcher applies. */
  requiresIntelligenceEntitlement?: boolean;
}

export const MARKETING_PILL_ITEMS: MarketingPillItem[] = [
  { label: "Console", to: PRODUCT_MANIFEST.dashboard.href },
  { label: "Audit", to: "/audit" },
  { label: "Recovery", to: PRODUCT_MANIFEST.recovery.href },
  { label: "Disputes", to: PRODUCT_MANIFEST.disputes.href },
  { label: "Intelligence", to: PRODUCT_MANIFEST.intelligence.href, requiresIntelligenceEntitlement: true },
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
