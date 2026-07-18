// Recovery-rate color thresholds (DESIGN.md): 0-20 red, 21-35 amber, 36+ green.
// Pure so later slices (5b payment status taxonomy) can reuse the same bands
// instead of re-deriving them.

export type RecoveryRateTone = "red" | "amber" | "green";

export function recoveryRateTone(pct: number): RecoveryRateTone {
  if (pct <= 20) return "red";
  if (pct <= 35) return "amber";
  return "green";
}

const TONE_CLASS_NAME: Record<RecoveryRateTone, string> = {
  red: "text-error-text",
  amber: "text-amber-text",
  green: "text-success-text",
};

export function recoveryRateClassName(pct: number): string {
  return TONE_CLASS_NAME[recoveryRateTone(pct)];
}
