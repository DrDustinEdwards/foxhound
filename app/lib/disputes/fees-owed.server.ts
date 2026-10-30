import { and, eq, isNotNull } from "drizzle-orm";

import type { Db } from "~/db";
import { billingInvoices, billingLineItems } from "~/db";
import { getBillableDisputes } from "~/db/billable";
import { SETTLED_STATUSES } from "~/lib/billing/charge-retry";

import type { MoneyPart } from "./stats";

// The disputes list's "Fees owed" card (J66 follow-up, Dustin's answer to PR #75
// question 5: "yes ro all", 2026-10-15,
// cmsg_01Nd8kh3hkgYNYpWXrNkvBQL2LnH5XBcKc3DcWHoEsDbT6).
//
// Recova's card summed its dispute_fees rows whose status was pending or
// invoiced (app/(app)/disputes/dashboard/page.tsx, blob c97c3e93), so a fee
// dropped off once paid. Foxhound's card had summed every fee on a won,
// Foxhound-submitted dispute, paid or not, so it overstated once fees were
// billed. Foxhound keeps the same facts in its billing records, and this reads
// them, READ-ONLY:
//
// - Pending: a win the next billing run will bill, exactly the set and the fee
//   /billing's preview shows (getBillableDisputes, the run's own query, and
//   the run's fee: the stored snapshot; an unpriced win is not yet pending).
// - Invoiced: a dispute_fee line on an invoice that is not settled. Settled is
//   the charge-retry sweep's own list (paid, void, uncollectible, gave_up):
//   nothing more will be collected on those, so nothing is owed. A failed charge
//   is still owed, as the sweep still chases it. A credit note against the line
//   reduces what is owed by its amount.
//
// No money writer, batch, key or order is touched; nothing here writes.

/** The dispute fees an account still owes, one part per fee, in its currency.
 *  The caller totals them per currency (groupSumByCurrency). */
export async function getDisputeFeesOwed(db: Db, accountId: string, nowMs: number): Promise<MoneyPart[]> {
  const [pending, invoiced, credits] = await Promise.all([
    getBillableDisputes(db, accountId, nowMs),
    db
      .select({
        id: billingLineItems.id,
        currency: billingLineItems.currency,
        amountCents: billingLineItems.amountCents,
        invoiceStatus: billingInvoices.status,
      })
      .from(billingLineItems)
      .innerJoin(billingInvoices, eq(billingInvoices.id, billingLineItems.invoiceId))
      .where(
        and(
          eq(billingLineItems.accountId, accountId),
          eq(billingInvoices.accountId, accountId),
          eq(billingLineItems.type, "dispute_fee"),
        ),
      ),
    db
      .select({ creditsLineItemId: billingLineItems.creditsLineItemId, amountCents: billingLineItems.amountCents })
      .from(billingLineItems)
      .where(
        and(
          eq(billingLineItems.accountId, accountId),
          eq(billingLineItems.type, "credit"),
          isNotNull(billingLineItems.creditsLineItemId),
        ),
      ),
  ]);

  const creditedCents = new Map<string, number>();
  for (const c of credits) {
    if (!c.creditsLineItemId) continue;
    creditedCents.set(c.creditsLineItemId, (creditedCents.get(c.creditsLineItemId) ?? 0) + Math.abs(c.amountCents));
  }

  // The run's own fee: the stored snapshot. An unpriced win is not pending.
  const parts: MoneyPart[] = pending.flatMap((d) =>
    d.resolvedFeeCents == null ? [] : [{ currency: d.currency, cents: d.resolvedFeeCents }],
  );
  for (const line of invoiced) {
    if (SETTLED_STATUSES.includes(line.invoiceStatus)) continue;
    const owed = line.amountCents - (creditedCents.get(line.id) ?? 0);
    if (owed > 0) parts.push({ currency: line.currency, cents: owed });
  }
  return parts;
}
