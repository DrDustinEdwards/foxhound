// Recovery-rate color thresholds (DESIGN.md): 0-20 red, 21-35 caution, 36+
// green. Pure so later slices (5b payment status taxonomy) can reuse the same
// bands instead of re-deriving them.

export type RecoveryRateTone = "red" | "caution" | "green";

/** The highest rate that is still red, and the highest that is still caution; above the second is green. */
export const RECOVERY_RATE_RED_MAX = 20;
export const RECOVERY_RATE_CAUTION_MAX = 35;

export function recoveryRateTone(pct: number): RecoveryRateTone {
  if (pct <= RECOVERY_RATE_RED_MAX) return "red";
  if (pct <= RECOVERY_RATE_CAUTION_MAX) return "caution";
  return "green";
}

const TONE_CLASS_NAME: Record<RecoveryRateTone, string> = {
  red: "fh-error",
  caution: "fh-brand",
  green: "fh-success",
};

/** The band as a Capsomer status tone (StatTile, Pill). */
export function recoveryRateStatusTone(pct: number): "crit" | "warn" | "ok" {
  return STATUS_TONE[recoveryRateTone(pct)];
}

const STATUS_TONE = { green: "ok", caution: "warn", red: "crit" } as const;

export function recoveryRateClassName(pct: number): string {
  return TONE_CLASS_NAME[recoveryRateTone(pct)];
}

/**
 * The band as a word, for the subtext under a recovery-rate stat. The number
 * alone does not tell a merchant whether 28% is good or bad; this does.
 */
export function recoveryRateBand(pct: number | null): string {
  if (pct === null) return "No failures yet";
  const tone = recoveryRateTone(pct);
  if (tone === "green") return "Above target";
  if (tone === "caution") return "Near target";
  return "Below target";
}

/**
 * Class name for a possibly-absent rate. Mirrors recoveryRateBand's null
 * handling so a no-history account renders subtle rather than alarming red.
 */
export function recoveryRateClassNameOrNull(pct: number | null): string {
  return pct === null ? "fh-faint" : recoveryRateClassName(pct);
}
