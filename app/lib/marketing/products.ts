// Shared product metadata (Phase 6 Pass 1). Two readers: the home page's
// product cards take every field here, and the /products hub
// (app/routes/products/index.tsx) takes only key, name and href, with its card
// copy from products-hub.ts (J16). Mirrors legacy lib/products.ts, but
// collapsed onto the ROUTES.md /products/* pattern: legacy split this
// across three duplicate trees (/product/*, /products, /features).

export type ProductKey = "audit" | "recovery" | "disputes" | "intelligence";

export interface ProductDef {
  key: ProductKey;
  name: string;
  description: string;
  price: string;
  priceLabel?: string;
  href: string;
}

export const PRODUCTS: Record<ProductKey, ProductDef> = {
  audit: {
    key: "audit",
    name: "Audit",
    description:
      "Free Stripe diagnostic. What Stripe already recovered, what is still dying, what Foxhound would add.",
    price: "Free",
    href: "/products/audit",
  },
  recovery: {
    key: "recovery",
    name: "Recovery",
    description:
      "Silent retries first, then AI-drafted email sequences, across 30 days. Four decline categories, four different sequences.",
    price: "20%",
    priceLabel: "of Foxhound-attributed recoveries",
    href: "/products/recovery",
  },
  disputes: {
    key: "disputes",
    name: "Disputes",
    description:
      "Evidence drafted for every dispute. You review and sign every submission before it reaches Stripe.",
    price: "20%",
    priceLabel: "of won disputes, capped at $500",
    href: "/products/disputes",
  },
  intelligence: {
    key: "intelligence",
    name: "Intelligence",
    description:
      "Free MRR, movements, churn, and cohorts for every Recovery merchant. Predictive risk scoring is the paid layer on top.",
    price: "$199/mo",
    priceLabel: "for predictive risk scoring, MRR analytics are free",
    href: "/products/intelligence",
  },
};

export const PRODUCT_ORDER: ProductKey[] = ["audit", "recovery", "disputes", "intelligence"];
