// Route manifest as DATA (task Part 2 rule 3): the nav renders from this, and
// test/nav-manifest.test.ts asserts every href/to exists in the real route tree (app/routes.ts), so
// nav and routes cannot silently drift.

export type ProductKey = "dashboard" | "recovery" | "disputes" | "intelligence";

export interface ProductNavLink {
  label: string;
  to: string;
  end?: boolean;
  requiresAccount?: boolean;
}

export interface ProductManifestEntry {
  key: ProductKey;
  label: string;
  href: string;
  /** Every page of the product sits under this prefix, written with its trailing slash. */
  prefix: string;
  links: ProductNavLink[];
}

export const PRODUCT_ORDER: ProductKey[] = ["dashboard", "recovery", "disputes", "intelligence"];

export const PRODUCT_MANIFEST: Record<ProductKey, ProductManifestEntry> = {
  dashboard: {
    key: "dashboard",
    label: "Dashboard",
    href: "/console",
    prefix: "/console/",
    links: [],
  },
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
  disputes: {
    key: "disputes",
    label: "Disputes",
    href: "/disputes/dashboard",
    prefix: "/disputes/",
    links: [],
  },
  intelligence: {
    key: "intelligence",
    label: "Intelligence",
    href: "/intelligence/dashboard",
    prefix: "/intelligence/",
    links: [
      { label: "Overview", to: "/intelligence/dashboard", end: true },
      { label: "Customers", to: "/intelligence/customers" },
      { label: "Recommendations", to: "/intelligence/recommendations" },
      { label: "Churn", to: "/intelligence/churn" },
      { label: "Reports", to: "/intelligence/reports" },
    ],
  },
};

// Utility (non-product) destinations, rendered in the gear dropdown, never in the product switcher.
// The avatar menu shows only Settings and Billing (site-header.tsx); the settings sidebar reaches
// the rest.
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
  // Notifications. The writer five engines waited on: it sets digest_enabled, the Slack pair, and
  // the two email toggles.
  { label: "Notifications", to: "/settings/notifications" },
  // Dispute settings. Same mechanism as its siblings.
  { label: "Dispute settings", to: "/settings/disputes" },
  { label: "Stripe connections", to: "/settings/stripe" },
  { label: "My account", to: "/settings/account" },
];

// Kept as its own data list beside the manifest rather than mutating PRODUCT_MANIFEST or renaming
// its keys/labels.
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
  return PRODUCT_ORDER.includes(value as ProductKey);
}

/** Which product a URL belongs to, or null for a platform/admin page. */
export function resolveProductFromPath(pathname: string): ProductKey | null {
  for (const key of PRODUCT_ORDER) {
    const { href, prefix } = PRODUCT_MANIFEST[key];
    if (pathname === href || pathname.startsWith(prefix)) return key;
  }
  return null;
}
