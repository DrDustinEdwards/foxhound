import { DISPUTE_FEE_BPS, INTELLIGENCE_PRICE_CENTS, RECOVERY_FEE_BPS } from "~/lib/constants";
import { formatMoneyShort } from "~/lib/money-format";

import type { ProductKey } from "./products";

// The /products hub's card copy (J16, row M5). Recova's spec is
// app/(marketing)/products/page.tsx (blob 1349c46e) for the Audit card and
// lib/products.ts (blob 6be24574) for the other three, word for word.
//
// Hub only. The home page reads the shared description and price in
// products.ts, which are a different row's copy, so they stay as they are.
// Names and hrefs still come from products.ts, the one place J09 moves the
// spoke links to /product/*.
//
// Every number is read from Foxhound's pricing constants, never typed
// (RULES.md 2.1). Recova's price is one string per card, and so is this.
//
// One truthfulness fix (RULES.md 1.2): Recova's Recovery price reads "20% of
// recoveries", but Foxhound bills only Foxhound-attributed recoveries;
// stripe_baseline recoveries are never billed (PRICING.md, Recovery;
// app/lib/billing/billable-predicates.ts, isBillableRecoveryRow). So it says
// "of Foxhound-attributed recoveries", PRICING.md's own wording.

const pct = (bps: number) => `${bps / 100}%`;

export interface HubCardCopy {
  description: string;
  price: string;
}

export const HUB_COPY: Record<ProductKey, HubCardCopy> = {
  audit: {
    description: "Full Stripe diagnostic. See what is leaking in 30 seconds.",
    price: "Free",
  },
  recovery: {
    description: "Failed payment recovery for Stripe merchants",
    price: `${pct(RECOVERY_FEE_BPS)} of Foxhound-attributed recoveries`,
  },
  disputes: {
    description: "Chargeback response and recovery. Pay only on success.",
    price: `${pct(DISPUTE_FEE_BPS)} on wins`,
  },
  intelligence: {
    description: "MRR analytics, churn prediction, customer health scoring, AI narrative",
    price: `${formatMoneyShort(INTELLIGENCE_PRICE_CENTS, "usd")}/mo`,
  },
};
