/** Audit settings: the lookback period and the monthly-digest opt-in. */

export const LOOKBACK_OPTIONS = [30, 60, 90, 180] as const;
export type LookbackOption = (typeof LOOKBACK_OPTIONS)[number];

/** AuditSection computes `safeLookback` exactly this way. */
const LOOKBACK_DEFAULT: LookbackOption = 90;

/**
 * Clamp any stored or submitted value onto the option set. Same resulting values, enforced one
 * layer deeper.
 */
export function normalizeLookback(value: unknown): LookbackOption {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return (LOOKBACK_OPTIONS as readonly unknown[]).includes(n)
    ? (n as LookbackOption)
    : LOOKBACK_DEFAULT;
}

/** How the stored columns render. */
export function readAuditSettings(row: {
  auditLookbackDays: number | null;
  auditAutoRun: boolean | null;
}): { lookbackDays: LookbackOption; autoRun: boolean } {
  return {
    lookbackDays: normalizeLookback(row.auditLookbackDays ?? LOOKBACK_DEFAULT),
    autoRun: row.auditAutoRun === true,
  };
}

/**
 * The digest opt-in as the future cron must read it: TRUE only when explicitly true. NULL and false
 * are both off.
 */
export function isDigestEnabled(auditAutoRun: boolean | null | undefined): boolean {
  return auditAutoRun === true;
}
