// Health-score band thresholds for the Intelligence UI (red at risk, caution
// watch, green healthy). Mirrors app/lib/dashboard/recovery-rate.ts. The
// at-risk cutoff is HEALTH_SCORE_AT_RISK_THRESHOLD, the same one that drives
// MRR-at-risk exposure and the narrative's top-N selection; "watch" is the
// band between at-risk and clearly healthy.

import type { MeterTone } from "capsomer/behavior/meter";

import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";

export type HealthScoreBand = "at_risk" | "watch" | "healthy";

export const WATCH_CEILING = 70;

export function healthScoreBand(score: number): HealthScoreBand {
  if (score < HEALTH_SCORE_AT_RISK_THRESHOLD) return "at_risk";
  if (score < WATCH_CEILING) return "watch";
  return "healthy";
}

const CLASS_NAME: Record<HealthScoreBand, string> = {
  at_risk: "text-error-text",
  watch: "text-caution",
  healthy: "text-success-text",
};

export function healthScoreClassName(score: number): string {
  return CLASS_NAME[healthScoreBand(score)];
}

const METER_TONE: Record<HealthScoreBand, MeterTone> = {
  at_risk: "crit",
  watch: "warn",
  healthy: "ok",
};

export function healthScoreMeterTone(score: number): MeterTone {
  return METER_TONE[healthScoreBand(score)];
}
