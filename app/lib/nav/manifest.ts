// Route manifest as DATA (task Part 2 rule 3): the nav renders from this, and
// test/nav-manifest.test.ts asserts every href/to exists in the real route
// tree (app/routes.ts), so nav and routes cannot silently drift.
//
// Recovery and Disputes are outcome-priced (PRICING.md) and Intelligence is
// free (Dustin, 2026-10-29), with no account_products gate on any route, so
// every product is always available to any account with a membership.
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
  /** Gear dropdown only: hidden for a signed-in visitor with no membership,
   *  matching legacy GearMenu's hasAccount gate on Billing. */
  requiresAccount?: boolean;
}

export interface ProductManifestEntry {
  key: ProductKey;
  label: string;
  /** Where the product switcher goes: the product's dashboard, at Recova's
   *  path (lib/products.ts `href`). */
  href: string;
  /** Every page of the product sits under this prefix, written with its
   *  trailing slash (Recova's `routePrefix`). Kept apart from href since J09:
   *  the dashboard is /recovery/dashboard, but /recovery/payments is Recovery
   *  too. */
  prefix: string;
  links: ProductNavLink[];
}

export const PRODUCT_ORDER: ProductKey[] = ["dashboard", "recovery", "disputes", "intelligence"];

export const PRODUCT_MANIFEST: Record<ProductKey, ProductManifestEntry> = {
  dashboard: { key: "dashboard", label: "Dashboard", href: "/console", prefix: "/console/", links: [] },
  recovery: {
    key: "recovery",
    label: "Recovery",
    href: "/recovery/dashboard",
    prefix: "/recovery/",
    links: [
      { label: "Overview", to: "/recovery/dashboard", end: true },
      { label: "Payments", to: "/recovery/payments" },
      { label: "Sequences", to: "/recovery/sequence" },
      { label: "Win-back", to: "/recovery/winback" },
      { label: "Expiring cards", to: "/recovery/expiring-cards" },
    ],
  },
  disputes: { key: "disputes", label: "Disputes", href: "/disputes/dashboard", prefix: "/disputes/", links: [] },
  intelligence: {
    key: "intelligence",
    label: "Intelligence",
    href: "/intelligence/dashboard",
    prefix: "/intelligence/",
    links: [
      { label: "Overview", to: "/intelligence/dashboard", end: true },
      { label: "Customers", to: "/intelligence/customers" },
      // Recova's place for it: after Customers, before Churn Risk (SiteNav.tsx).
      { label: "Recommendations", to: "/intelligence/recommendations" },
      { label: "Churn", to: "/intelligence/churn" },
      { label: "Reports", to: "/intelligence/reports" },
    ],
  },
};

// Utility (non-product) destinations, rendered in the gear dropdown, never
// in the product switcher.
//
// Order and gating are legacy's, from legacy components/GearMenu.tsx source:
// Settings, then Billing (rendered only when hasAccount, because legacy's
// /console redirects an accountless user to /connect and Billing would be a
// dead row), then Help. Those three hold legacy's exact relative order and
// positions.
//
// The rows after those three are every other page the app shell names. The
// avatar menu shows only Settings and Billing (site-header.tsx); the settings
// sidebar reaches the rest.
export const PLATFORM_LINKS: ProductNavLink[] = [
  { label: "Settings", to: "/settings" },
  { label: "Billing", to: "/billing", requiresAccount: true },
  { label: "Help", to: "/help" },
  { label: "Team", to: "/settings/team" },
  { label: "Audit settings", to: "/settings/audit" },
  { label: "Audit history", to: "/audit/dashboard" },
  { label: "Email settings", to: "/settings/email" },
  { label: "API keys", to: "/settings/api-keys" },
  { label: "Brand voice", to: "/settings/brand-voice" },
  // Notifications (S36). The writer five engines waited on: it sets
  // digest_enabled, the Slack pair, and the two email toggles.
  { label: "Notifications", to: "/settings/notifications" },
  // Dispute settings (S32, J06). Same mechanism as its siblings.
  { label: "Dispute settings", to: "/settings/disputes" },
  // S24 and S25: legacy's hub gained two sub-pages when the
  // inline cards were split off it.
  { label: "Stripe connections", to: "/settings/stripe" },
  { label: "My account", to: "/settings/account" },
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
}

export const MARKETING_PILL_ITEMS: MarketingPillItem[] = [
  { label: "Console", to: PRODUCT_MANIFEST.dashboard.href },
  { label: "Audit", to: "/audit" },
  { label: "Recovery", to: PRODUCT_MANIFEST.recovery.href },
  { label: "Disputes", to: PRODUCT_MANIFEST.disputes.href },
  { label: "Intelligence", to: PRODUCT_MANIFEST.intelligence.href },
];

export function isProductKey(value: string | null | undefined): value is ProductKey {
  return value === "dashboard" || value === "recovery" || value === "disputes" || value === "intelligence";
}

/** Which product a URL belongs to, or null for a platform/admin page. */
export function resolveProductFromPath(pathname: string): ProductKey | null {
  for (const key of PRODUCT_ORDER) {
    const { href, prefix } = PRODUCT_MANIFEST[key];
    if (pathname === href || pathname.startsWith(prefix)) return key;
  }
  return null;
}
