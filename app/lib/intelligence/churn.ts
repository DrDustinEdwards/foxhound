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

/** One month of the churn-rate chart, as the churn view returns it. */
export interface ChurnRatePointLike {
  at: Date;
  voluntaryPct: number | null;
  involuntaryPct: number | null;
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function pct(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

function seriesSentence(name: string, values: (number | null)[]): string {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return `${name} churn has no rate yet`;
  const first = present[0];
  const last = present[present.length - 1];
  if (present.length === 1) return `${name} churn was ${pct(first)}`;
  return `${name} churn went from ${pct(first)} to ${pct(last)}`;
}

/**
 * The churn-rate chart's text alternative (capsid/conventions-web.md rule 8):
 * the window and, per series, where it started and ended. Computed from the
 * same points the chart draws, so the words cannot disagree with the picture.
 * A month with no rate is a gap here as on the chart, never a zero.
 */
export function churnRateAlt(points: readonly ChurnRatePointLike[]): string {
  if (points.length === 0) return "Monthly churn rate: no snapshots yet.";
  const start = MONTH.format(points[0].at);
  const end = MONTH.format(points[points.length - 1].at);
  const window = start === end ? start : `${start} to ${end}`;
  const involuntary = seriesSentence("Involuntary", points.map((p) => p.involuntaryPct));
  const voluntary = seriesSentence("voluntary", points.map((p) => p.voluntaryPct));
  return `Monthly churn rate, ${window}. ${involuntary}; ${voluntary}.`;
}
