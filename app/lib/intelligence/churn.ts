// Pure churn-surface helpers. Separate from views.server.ts because the churn
// route's COMPONENT needs this, and a value import from a *.server.ts module in
// a component fails the client build ("Server-only module referenced by
// client"). Types can cross that boundary because they are erased; values
// cannot. Same reason app/routes/app/recovery/payments/index.tsx keeps its own
// page-size constant.

/**
 * Share of scored MRR one health band represents, as a rounded whole percent.
 *
 * The denominator is scored MRR, not total account MRR. Legacy divided band
 * totals (which only counted customers with a health score) by every customer's
 * MRR (scored or not), so the three shares silently failed to sum to 100%
 * whenever anyone was unscored, with nothing on screen explaining the gap.
 */
export function churnBandSharePct(bandMrrCents: number, scoredMrrCents: number): number {
  if (scoredMrrCents <= 0) return 0;
  return Math.round((bandMrrCents / scoredMrrCents) * 100);
}
