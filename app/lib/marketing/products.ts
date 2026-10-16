// Shared product metadata (Phase 6 Pass 1). The home page's product cards take
// key, name and href (their copy is in home-copy.ts since J59), and the /products hub
// (app/routes/products/index.tsx) takes only key, name and href, with its card
// copy from products-hub.ts (J16). Mirrors legacy lib/products.ts; each href is
// Recova's own /product/<name> page, which Foxhound serves since J09.

import {
  DECLINE_CATEGORY_COUNT_WORD,
  DISTINCT_SEQUENCE_COUNT,
  RECOVERY_SEQUENCE_DAYS,
  countWord,
} from "./decline-categories";

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
    href: "/product/audit",
  },
  recovery: {
    key: "recovery",
    name: "Recovery",
    description:
      // Read from the engine: it schedules more categories than sequences.
      `Silent retries first, then AI-drafted email sequences, across ${RECOVERY_SEQUENCE_DAYS} days. ${DECLINE_CATEGORY_COUNT_WORD} decline categories, ${countWord(DISTINCT_SEQUENCE_COUNT).toLowerCase()} different sequences.`,
    price: "20%",
    priceLabel: "of Foxhound-attributed recoveries",
    href: "/product/recovery",
  },
  disputes: {
    key: "disputes",
    name: "Disputes",
    description:
      "Evidence drafted for every dispute. You review and sign every submission before it reaches Stripe.",
    price: "20%",
    priceLabel: "of won disputes, capped at $500",
    href: "/product/disputes",
  },
  intelligence: {
    key: "intelligence",
    name: "Intelligence",
    description:
      "Free MRR, movements, churn, and cohorts for every Recovery merchant. Predictive risk scoring is the paid layer on top.",
    price: "$199/mo",
    priceLabel: "for predictive risk scoring, MRR analytics are free",
    href: "/product/intelligence",
  },
};

export const PRODUCT_ORDER: ProductKey[] = ["audit", "recovery", "disputes", "intelligence"];
