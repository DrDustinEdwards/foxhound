import "capsomer/status.css";

import { healthScoreBand, METER_TONE } from "~/lib/intelligence/health-band";

// Ported from legacy components/docs/HealthScoreBadge.tsx (blob f25f29d8): a
// pill rendering the raw 0-100 score in mono, so it lines up inside a table
// column. The pill is Capsomer's, so each band carries its status shape
// as well as its color, and the number is never color alone.
//
// The BANDS are Foxhound's, not legacy's, and deliberately so.
// Legacy hardcodes red at or below 33, its accent color 34-66, green at or
// above 67. Foxhound's engine bands at_risk below 40, watch 40-69, healthy at
// or above 70, guarded by test/intelligence-health-band.test.ts. Carrying
// legacy's numbers over would render a 38 in the middle band here while the
// product classifies it at_risk, so the tone is driven from healthScoreBand
// rather than restated.
const BAND_WORD: Record<ReturnType<typeof healthScoreBand>, string> = {
  at_risk: "at risk",
  watch: "watch",
  healthy: "healthy",
};

export function HealthScoreBadge({ score }: { score: number }) {
  const band = healthScoreBand(score);
  return (
    // Recova's badge: the score in mono on the band's tint, edged in its color,
    // with no glyph; the band's word is for screen readers.
    <span
      className="cap-pill fh-pill-word fh-mono fh-tiny"
      data-variant="tag"
      data-tone={METER_TONE[band]}
    >
      {score}
      <span className="cap-sr-only">, {BAND_WORD[band]}</span>
    </span>
  );
}
