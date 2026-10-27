import { byAccountActive } from "~/db/scope";
import type { Db } from "~/db";
import { recoveredPayments } from "~/db";
import { BILLABLE_ATTRIBUTION_KINDS } from "~/lib/constants";

// The audit's "Foxhound adds" band: this account's own billable recoveries,
// summed per currency. The monthly audit email reads it.

export interface CurrencyCents {
  currency: string;
  cents: number;
}

/**
 * "Foxhound adds": the sum of THIS account's own recovered_payments rows
 * attributed to a Foxhound action (foxhound_retry, email_engaged,
 * card_update), i.e. everything that is NOT the free stripe_baseline. Reuses
 * the exact BILLABLE_ATTRIBUTION_KINDS filter the billing run and the
 * dashboard already use (PRICING.md: "Audit lift and the invoice are the
 * same query"), never a second hand-rolled predicate. For a freshly
 * connected account with no Foxhound history yet, this is honestly zero for
 * every currency, not a fabricated projection.
 */
export async function computeFoxhoundAddsCents(db: Db, accountId: string): Promise<CurrencyCents[]> {
  const rows = await db
    .select({
      currency: recoveredPayments.currency,
      amountCents: recoveredPayments.amountCents,
      attributionKind: recoveredPayments.attributionKind,
    })
    .from(recoveredPayments)
    .where(byAccountActive(recoveredPayments.accountId, recoveredPayments.deletedAt, accountId));

  const billable = new Set<string>(BILLABLE_ATTRIBUTION_KINDS);
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!billable.has(row.attributionKind)) continue;
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amountCents);
  }
  return [...totals.entries()].map(([currency, cents]) => ({ currency, cents }));
}
