/** Audit settings: the lookback period and the monthly-digest opt-in (S30, 315).
 *
 *  LEGACY IS THE SPEC, read WHOLE at blob shas per 260:
 *    app/(app)/settings/audit/page.tsx        18e6a384, 1,068 bytes
 *    app/(app)/settings/audit/AuditForm.tsx   5bf81c10, 786 bytes
 *    app/(app)/settings/components/AuditSection.tsx  58c5abce, 2,357 bytes
 *    components/Toggle.tsx                    0ebdd395, 1,157 bytes
 *
 *  THE COLUMN PAIR IS EXACTLY THE KNOWN PAIR, confirmed rather than assumed:
 *  legacy's page selects `audit_lookback_days, audit_auto_run` and nothing else,
 *  so the walk's record of the pair is complete and this port touches no other
 *  column.
 *
 *  NULL IS OFF, and legacy AGREES rather than being diverged from. Legacy's own
 *  page reads `(row?.audit_auto_run as boolean | null) ?? false` and
 *  `(row?.audit_lookback_days as number | null) ?? 90`, so the defaulting happens
 *  in the READ, not in the schema. **That is why 315's no-migration instruction
 *  is also the parity-correct answer: adding a DEFAULT would diverge from legacy
 *  AND opt existing rows into something nobody chose.** Live rows stay NULL and
 *  read as off.
 */

/** Legacy's four choices, in legacy's order (AuditSection.tsx). */
export const LOOKBACK_OPTIONS = [30, 60, 90, 180] as const;
export type LookbackOption = (typeof LOOKBACK_OPTIONS)[number];

/** Legacy's fallback, used both for a missing column and for a value outside the
 *  option set. AuditSection computes `safeLookback` exactly this way. */
export const LOOKBACK_DEFAULT: LookbackOption = 90;

/** Clamp any stored or submitted value onto the option set.
 *
 *  Legacy clamps on RENDER (safeLookback) and its form then posts the clamped
 *  value, so an out-of-set number can never round-trip. Foxhound clamps on WRITE
 *  as well, because an RR8 action accepts whatever a client posts and legacy's
 *  client-side clamp is not a server-side guarantee. Same resulting values,
 *  enforced one layer deeper. */
export function normalizeLookback(value: unknown): LookbackOption {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return (LOOKBACK_OPTIONS as readonly unknown[]).includes(n)
    ? (n as LookbackOption)
    : LOOKBACK_DEFAULT;
}

/** How the stored columns render. NULL is OFF and NULL is 90, which is legacy's
 *  `??` behaviour moved into one named place so the cron-facing read and the page
 *  cannot disagree about what NULL means. */
export function readAuditSettings(row: {
  auditLookbackDays: number | null;
  auditAutoRun: boolean | null;
}): { lookbackDays: LookbackOption; autoRun: boolean } {
  return {
    lookbackDays: normalizeLookback(row.auditLookbackDays ?? LOOKBACK_DEFAULT),
    autoRun: row.auditAutoRun === true,
  };
}

/** The digest opt-in as the future cron must read it: TRUE only when explicitly
 *  true. NULL and false are both off.
 *
 *  Session 25 halted the monthly cron because nothing could set this column; the
 *  page that 315 builds is what makes it settable. Exporting the predicate here
 *  means the cron (Session 27) reads the same rule the page writes, rather than
 *  re-deriving "on" and risking a disagreement about NULL. */
export function isDigestEnabled(auditAutoRun: boolean | null | undefined): boolean {
  return auditAutoRun === true;
}
