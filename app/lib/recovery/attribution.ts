import { BILLABLE_ATTRIBUTION_KINDS, type AttributionKind } from "~/lib/constants";
import { isRetryStep } from "~/lib/recovery/schedule";

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

/** The recovery_steps row shape findAttributionSignals reads. */
export interface AttributionStepRow {
  id: string;
  stepType: string;
  result: string | null;
  clickedAt: Date | null;
}

/** Milliseconds of a step's click. Built through `new Date` rather than
 *  `.getTime()` directly so a driver handing back an ISO string instead of a
 *  Date cannot make the comparator throw on the money path. */
function clickedAtMs(step: AttributionStepRow): number {
  return new Date(step.clickedAt as Date).getTime();
}

/**
 * Find the attribution signals present in a failed payment's recovery_steps,
 * pure so it is unit-testable without a database (webhooks/process.ts fetches
 * the rows and calls this). A succeeded retry step is `isRetryStep` +
 * result "retry_succeeded"; a completed card update is stepType "card_update"
 * + result "card_updated" (the signal recorded by the hosted /p/:token page,
 * app/lib/card-update/signal.ts); a clicked dunning email has clickedAt set.
 * All three refs point at recovery_steps.id (SCHEMA.md spine #1).
 */
export function findAttributionSignals(steps: AttributionStepRow[]): AttributionSignals {
  const succeededRetry = steps.find(
    (s) => isRetryStep(s.stepType) && s.result === "retry_succeeded",
  );
  const cardUpdate = steps.find(
    (s) => s.stepType === "card_update" && s.result === "card_updated",
  );
  // THE LATEST CLICK WINS, AND THE ORDERING IS DONE HERE (ruling 377(3)).
  //
  // This was `steps.find((s) => s.clickedAt != null)` against a caller query
  // that has no `orderBy` (webhooks/process.ts), so which click became the
  // billable signal was decided by D1 row order. That is a bug on the money
  // path: the attributing step id is the evidence FK the merchant's invoice
  // line points at, so row order was choosing what the ledger says caused the
  // recovery. Legacy ordered `executed_at desc` and the rebuild dropped it.
  //
  // The sort lives in this pure function rather than in the caller's SQL on
  // purpose. It is the selection itself, it is provable without a database,
  // and it fixes every caller at once: process.ts and demo/recovery-seed.ts
  // both read rows and hand them here, and a future caller with any row order
  // gets the same answer. Adding `orderBy` to the query as well would leave
  // two overlapping guards where neither can be shown to fail on its own.
  //
  // `filter` returns a fresh array, so sorting it cannot reorder the caller's.
  const clicked = steps
    .filter((s) => s.clickedAt != null)
    .sort((a, b) => clickedAtMs(b) - clickedAtMs(a))[0];
  return {
    succeededRetryStepId: succeededRetry?.id ?? null,
    cardUpdateRef: cardUpdate?.id ?? null,
    clickedEngagementId: clicked?.id ?? null,
  };
}
