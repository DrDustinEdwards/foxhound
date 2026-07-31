import { healthScoreBand } from "~/lib/intelligence/health-band";

// Ported from legacy components/docs/HealthScoreBadge.tsx. Legacy's TREATMENT
// is carried over exactly: a bordered, rounded-full, font-mono pill at
// 0.6875rem rendering the raw 0-100 score, so it lines up vertically inside
// table columns.
//
// The BANDS are Foxhound's, not legacy's, and deliberately so (ruling 79).
// Legacy hardcodes red at or below 33, amber 34-66, green at or above 67.
// Foxhound's engine bands at_risk below 40, watch 40-69, healthy at or above
// 70, guarded by test/intelligence-health-band.test.ts. Carrying legacy's
// numbers over would render a 38 amber here while the product classifies it
// at_risk, so the colour is driven from healthScoreBand rather than restated.
const BAND_CLASS: Record<ReturnType<typeof healthScoreBand>, string> = {
  at_risk: "border-red bg-red-bg text-error-text",
  watch: "border-amber bg-amber-bg text-amber-text",
  healthy: "border-green bg-green-bg text-green",
};

export function HealthScoreBadge({ score }: { score: number }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-micro font-medium ${BAND_CLASS[healthScoreBand(score)]}`}
    >
      {score}
    </span>
  );
}
