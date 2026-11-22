// Health-score band thresholds for the Intelligence UI (red at risk, caution watch, green healthy). The at-risk
// cutoff is HEALTH_SCORE_AT_RISK_THRESHOLD, the one that drives MRR-at-risk and the narrative's top-N selection.

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
  at_risk: "fh-error",
  watch: "fh-brand",
  healthy: "fh-success",
};

export function healthScoreClassName(score: number): string {
  return CLASS_NAME[healthScoreBand(score)];
}

export const METER_TONE: Record<HealthScoreBand, MeterTone> = {
  at_risk: "crit",
  watch: "warn",
  healthy: "ok",
};

export function healthScoreMeterTone(score: number): MeterTone {
  return METER_TONE[healthScoreBand(score)];
}
