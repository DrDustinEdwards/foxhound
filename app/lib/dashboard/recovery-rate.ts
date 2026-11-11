// Recovery-rate color thresholds (DESIGN.md): 0-20 red, 21-35 caution, 36+ green.
// Pure so later slices (5b payment status taxonomy) can reuse the same bands
// instead of re-deriving them.

export type RecoveryRateTone = "red" | "caution" | "green";

export function recoveryRateTone(pct: number): RecoveryRateTone {
  if (pct <= 20) return "red";
  if (pct <= 35) return "caution";
  return "green";
}

const TONE_CLASS_NAME: Record<RecoveryRateTone, string> = {
  red: "text-error-text",
  caution: "text-caution",
  green: "text-success-text",
};

export function recoveryRateClassName(pct: number): string {
  return TONE_CLASS_NAME[recoveryRateTone(pct)];
}

/**
 * The band as a word, for the subtext under a recovery-rate stat. The number
 * alone does not tell a merchant whether 28% is good or bad; this does.
 *
 * Accepts null (an account with no failures yet) because that case is genuinely
 * different from 0%: nothing has failed, so there is no rate to judge, and
 * "Below target" would be a false accusation.
 */
export function recoveryRateBand(pct: number | null): string {
  if (pct === null) return "No failures yet";
  const tone = recoveryRateTone(pct);
  if (tone === "green") return "Above target";
  if (tone === "caution") return "Near target";
  return "Below target";
}

/** Class name for a possibly-absent rate. Mirrors recoveryRateBand's null
 *  handling so a no-history account renders subtle rather than alarming red. */
export function recoveryRateClassNameOrNull(pct: number | null): string {
  return pct === null ? "text-text-subtle" : recoveryRateClassName(pct);
}
