import { getConnectedStripe } from "~/lib/stripe/client";
import { byAccountActive } from "~/db/scope";
import type { Db } from "~/db";
import { recoveredPayments } from "~/db";
import {
  AUDIT_LOOKBACK_DAYS,
  AUDIT_MAX_INVOICES_SCANNED,
  BILLABLE_ATTRIBUTION_KINDS,
  DAY_MS,
} from "~/lib/constants";

// Data/query layer for the authenticated "full audit" (ROUTES.md: "/audit,
// no-auth estimator (Turnstile) -> Stripe connect -> full audit report", one
// flow with no separately documented authenticated route). Per
// TASK-foxhound-phase6.md's conservative-read instruction, this pass builds
// ONLY this data/query layer, not a new authenticated route or UI: nothing
// here is wired into a loader. It computes the same three lift bands
// DESIGN.md's flagship audit surface calls for (Stripe recovered / still
// dying / Foxhound adds) against a connected account's LIVE Stripe data,
// following the same account-scoped read patterns as
// app/lib/dashboard/stats.server.ts.
//
// Mirrors the established precedent in app/lib/card-update/service.ts: the
// live-Stripe-calling half (computeStripeInvoiceLiftBands) typechecks and is
// built for real, but is NOT live-verified this pass (needs a live Stripe
// test-mode connected account, a Phase 8 dependency). The pure aggregation
// half (computeFoxhoundAddsCents, mergeAuditLiftBands) is unit-tested.

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

export interface StripeInvoiceLiftBands {
  currency: string;
  /** Invoices that failed at least once but were eventually paid: what Stripe's own retries already recovered. */
  stripeBaselineRecoveredCents: number;
  /** Invoices still uncollectible or open with no further retry scheduled: still dying, unrecovered by anyone. */
  stillDyingCents: number;
  failedInvoicesCount: number;
  failedInvoicesCents: number;
}

/**
 * Scans the connected account's own Stripe invoices over the trailing
 * AUDIT_LOOKBACK_DAYS window and buckets them into the two Stripe-side lift
 * bands. Bounded to AUDIT_MAX_INVOICES_SCANNED per run (mirrors the
 * RETENTION_SWEEP_LIMIT discipline: a large backlog is scanned across
 * successive runs, not all at once). Requires a live Stripe test-mode
 * connected account to exercise; not live-verified this pass.
 */
export async function computeStripeInvoiceLiftBands(
  accessToken: string,
  nowMs: number,
  lookbackDays: number = AUDIT_LOOKBACK_DAYS,
): Promise<StripeInvoiceLiftBands[]> {
  const stripe = getConnectedStripe(accessToken);
  const sinceUnixSeconds = Math.floor((nowMs - lookbackDays * DAY_MS) / 1000);

  const byCurrency = new Map<string, StripeInvoiceLiftBands>();
  function bucket(currency: string): StripeInvoiceLiftBands {
    let b = byCurrency.get(currency);
    if (!b) {
      b = { currency, stripeBaselineRecoveredCents: 0, stillDyingCents: 0, failedInvoicesCount: 0, failedInvoicesCents: 0 };
      byCurrency.set(currency, b);
    }
    return b;
  }

  let scanned = 0;
  for await (const invoice of stripe.invoices.list({ created: { gte: sinceUnixSeconds }, limit: 100 })) {
    scanned += 1;
    if (scanned > AUDIT_MAX_INVOICES_SCANNED) break;

    const hadAFailure = (invoice.attempt_count ?? 0) > 1 || invoice.status === "uncollectible";
    if (!hadAFailure) continue;

    const b = bucket(invoice.currency ?? "usd");
    b.failedInvoicesCount += 1;
    b.failedInvoicesCents += invoice.amount_due ?? 0;

    if (invoice.status === "paid") {
      b.stripeBaselineRecoveredCents += invoice.amount_paid ?? 0;
    } else if (invoice.status === "uncollectible" || (invoice.status === "open" && !invoice.next_payment_attempt)) {
      b.stillDyingCents += invoice.amount_due ?? 0;
    }
  }

  return [...byCurrency.values()];
}

export interface AuditLiftBand {
  currency: string;
  stripeBaselineRecoveredCents: number;
  stillDyingCents: number;
  foxhoundAddsCents: number;
}

/**
 * Merges the Stripe-side bands (stripe_baseline_recovered, still_dying) with
 * Foxhound's own attributed-recovery total (foxhound_adds), matched by
 * currency. A currency present in one input but not the other still
 * produces a row (missing amounts default to 0, not omitted), since a
 * currency Foxhound has recovered in but Stripe shows no failures for this
 * window is a real, honest zero on the Stripe side, not an error.
 */
export function mergeAuditLiftBands(
  stripeBands: StripeInvoiceLiftBands[],
  foxhoundAdds: CurrencyCents[],
): AuditLiftBand[] {
  const currencies = new Set<string>([
    ...stripeBands.map((b) => b.currency),
    ...foxhoundAdds.map((c) => c.currency),
  ]);
  const foxhoundByCurrency = new Map(foxhoundAdds.map((c) => [c.currency, c.cents]));
  const stripeByCurrency = new Map(stripeBands.map((b) => [b.currency, b]));

  return [...currencies].map((currency) => {
    const stripeBand = stripeByCurrency.get(currency);
    return {
      currency,
      stripeBaselineRecoveredCents: stripeBand?.stripeBaselineRecoveredCents ?? 0,
      stillDyingCents: stripeBand?.stillDyingCents ?? 0,
      foxhoundAddsCents: foxhoundByCurrency.get(currency) ?? 0,
    };
  });
}
