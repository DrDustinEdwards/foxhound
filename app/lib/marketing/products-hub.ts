import { DISPUTE_FEE_PERCENT, RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";

import type { ProductKey } from "./products";

// The /products hub's card copy. Hub only: the home page reads the shared description and price in products.ts. Names and hrefs
// come from products.ts. Every number is read from Foxhound's pricing constants, never typed; the price is one string per card.
// Truthfulness: Recovery says "of Foxhound-attributed recoveries" because stripe_baseline recoveries are never billed
// (app/lib/billing/billable-predicates.ts, isBillableRecoveryRow); Disputes names the per-dispute fee cap (DISPUTE_FEE_CAP_CENTS,
// applied in app/lib/billing/run.ts), as /pricing does; Intelligence says "Free" because it is free on every account.

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
    price: `${RECOVERY_FEE_PERCENT}% of Foxhound-attributed recoveries`,
  },
  disputes: {
    description: "Chargeback response and recovery. Pay only on success.",
    price: `${DISPUTE_FEE_PERCENT}% on wins, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")}`,
  },
  intelligence: {
    description: "MRR analytics, churn prediction, customer health scoring, monthly narrative",
    price: "Free",
  },
};
