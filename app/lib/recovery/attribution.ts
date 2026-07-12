import { BILLABLE_ATTRIBUTION_KINDS, type AttributionKind } from "~/lib/constants";

// Attribution is first-class (SCHEMA.md spine #1, PRICING.md): a recovery is
// BILLABLE only when a Foxhound action provably preceded the payment. This
// module decides the attribution kind for a recovered payment from the Foxhound
// actions that preceded it. Everything with no Foxhound action is the free
// `stripe_baseline`.

export interface AttributionSignals {
  /** A Foxhound-scheduled retry step succeeded for this failed payment (step id). */
  succeededRetryStepId?: string | null;
  /** The customer updated their card via the Foxhound hosted page (event ref). */
  cardUpdateRef?: string | null;
  /** The customer clicked a Foxhound dunning email (engagement event id). Click,
   *  not open: opens are inflated by Apple MPP and never bill (PRICING.md). */
  clickedEngagementId?: string | null;
}

export interface ResolvedAttribution {
  kind: AttributionKind;
  ref: string | null;
}

/**
 * Decide how a recovery is attributed, in priority order:
 *   foxhound_retry (we made the charge succeed)
 *   > card_update (we fixed the payment method)
 *   > email_engaged (our email drove the click)
 *   > stripe_baseline (no Foxhound action - free).
 * The order is deliberate: a succeeded retry is the strongest proof of causation,
 * so it wins over a coincident click.
 */
export function resolveAttribution(signals: AttributionSignals): ResolvedAttribution {
  if (signals.succeededRetryStepId) {
    return { kind: "foxhound_retry", ref: signals.succeededRetryStepId };
  }
  if (signals.cardUpdateRef) {
    return { kind: "card_update", ref: signals.cardUpdateRef };
  }
  if (signals.clickedEngagementId) {
    return { kind: "email_engaged", ref: signals.clickedEngagementId };
  }
  return { kind: "stripe_baseline", ref: null };
}

/** True for the attributed (billable) kinds; false for the free baseline. */
export function isBillableAttribution(kind: AttributionKind): boolean {
  return (BILLABLE_ATTRIBUTION_KINDS as readonly string[]).includes(kind);
}
