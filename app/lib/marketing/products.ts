// Shared product metadata. The home page's product cards take key, name and href (copy in home-copy.ts); the /products hub
// (app/routes/products/index.tsx) takes the same, with its card copy from products-hub.ts. Each href is a /product/<name> page.

import { DISPUTE_FEE_PERCENT, RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";

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
      `AI email sequences and silent retries across ${RECOVERY_SEQUENCE_DAYS} days. ${DECLINE_CATEGORY_COUNT_WORD} decline categories, ${countWord(DISTINCT_SEQUENCE_COUNT).toLowerCase()} different sequences.`,
    price: `${RECOVERY_FEE_PERCENT}%`,
    priceLabel: "of Foxhound-attributed recoveries",
    href: "/product/recovery",
  },
  disputes: {
    key: "disputes",
    name: "Disputes",
    description:
      "Evidence drafted for every dispute. You approve every submission before it reaches Stripe, or turn on auto-submit.",
    price: `${DISPUTE_FEE_PERCENT}%`,
    priceLabel: `of won disputes, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")}`,
    href: "/product/disputes",
  },
  intelligence: {
    key: "intelligence",
    name: "Intelligence",
    description:
      "MRR analytics, churn prediction, customer health scoring, and a nightly plain-English summary.",
    price: "Free",
    priceLabel: "for every account",
    href: "/product/intelligence",
  },
};

export const PRODUCT_ORDER: ProductKey[] = ["audit", "recovery", "disputes", "intelligence"];
