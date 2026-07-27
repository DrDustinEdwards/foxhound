// Pure half of the global emergency brake: the type-to-confirm phrases and the
// matcher. Deliberately NOT in brake.server.ts, because the phrases are rendered
// in the panel AND validated in the action, and importing a .server module into
// a component body ships the server bundle to the browser (a build break, and a
// secrets problem).

// The accounts.pause_reason vocabulary. Lives in the PURE module because both
// the brake (brake.server.ts) and the single-merchant toggle
// (merchants.server.ts) write it, and brake.server.ts already imports
// merchants.server.ts, so putting it there would close an import cycle.
//
// 'brake' is the only value release acts on. 'manual' exists so a
// human-initiated pause is positively marked rather than merely unmarked: a null
// reason used to mean "individually paused", which made "paused by a person" and
// "paused by something that forgot to say why" the same state.

/** The global brake paused this row. Release resumes exactly these. */
export const PAUSE_REASON_BRAKE = "brake";
/** A human paused this row one at a time. Release must never touch these. */
export const PAUSE_REASON_MANUAL = "manual";

/** Every reason the app writes. A paused row carrying anything else is drift and
 *  is surfaced by countStaleMarkers, because release keys on the exact 'brake'
 *  string and would silently never touch such a row. */
export const KNOWN_PAUSE_REASONS = [PAUSE_REASON_BRAKE, PAUSE_REASON_MANUAL] as const;

/** Every destructive control on the brake panel is gated on typing its exact
 *  phrase. No single-click path exists for any of them.
 *
 *  That claim used to be true of the panel and false of the platform: the same
 *  recovery tick could be re-enabled in ONE click from /admin/crons, which is a
 *  different page with none of this friction (review MEDIUM-4). The cron page's
 *  enable direction now goes through cronEnableConfirmPhrase below, so the
 *  sentence above holds everywhere the tick can be started, not just here. */
export const BRAKE_CONFIRM_PHRASES = {
  engage: "PAUSE ALL",
  release: "RESUME ALL",
  "tick-disable": "STOP TICK",
  "tick-enable": "START TICK",
} as const;

export type BrakeIntent = keyof typeof BRAKE_CONFIRM_PHRASES;

export function isBrakeIntent(value: string): value is BrakeIntent {
  return value in BRAKE_CONFIRM_PHRASES;
}

/**
 * Whether the operator's typed confirmation matches the intent's phrase.
 *
 * Trimmed (a trailing space from a paste or an autocomplete should not read as
 * a refusal to confirm) but case-SENSITIVE and never partial: "pause all" and
 * "PAUSE" both fail. The phrase exists to force a deliberate act, so anything
 * that makes it easier to satisfy by accident defeats it.
 */
export function isConfirmPhraseValid(intent: BrakeIntent, typed: string): boolean {
  return typed.trim() === BRAKE_CONFIRM_PHRASES[intent];
}

/**
 * The phrase /admin/crons requires before ENABLING a cron.
 *
 * Per-cron rather than one shared word, so a confirmation typed for one job can
 * never start another: enabling billing-monthly is at least as consequential as
 * enabling recovery-tick, and a generic "START CRON" would let a stale form or a
 * misread row start the wrong one.
 *
 * Only the enable direction is gated. Stopping a loop that charges cards is
 * safe; starting one is not, and friction belongs where the damage is.
 *
 * Lives in this pure module, not crons.server.ts, for the reason at the top of
 * the file: the phrase is rendered in a component AND validated in an action, and
 * importing a .server module into a component body ships the server bundle to the
 * browser.
 */
export function cronEnableConfirmPhrase(cronName: string): string {
  return `ENABLE ${cronName}`;
}

/** Trimmed but case-SENSITIVE and never partial, exactly like
 *  isConfirmPhraseValid. Same reasoning: the phrase exists to force a deliberate
 *  act, so anything that makes it easier to satisfy by accident defeats it. */
export function isCronEnableConfirmValid(cronName: string, typed: string): boolean {
  return typed.trim() === cronEnableConfirmPhrase(cronName);
}

/**
 * What the panel says after a clean engage or release.
 *
 * Both counts are needed because they can now legitimately differ without any
 * failure: the flag writes re-apply the selecting predicate, so a row that
 * stopped matching between the eligibility read and its chunk is skipped
 * (review MEDIUM-1/INFO-2). Reporting the transitioned count alone would leave
 * an operator staring at "Paused 29" under a button that had just promised 30,
 * with nothing on the page accounting for the difference. Pure so the wording is
 * testable without driving the route.
 */
function skippedClause(intendedCount: number, affectedCount: number, what: string): string {
  const skipped = intendedCount - affectedCount;
  if (skipped <= 0) return "";
  return ` ${skipped} account(s) ${what} by the time the write ran, so they were left exactly as they are.`;
}

export function engageResultMessage(result: { affectedCount: number; intendedCount: number }): string {
  if (result.intendedCount === 0) {
    return "Brake engaged. No accounts were eligible to pause (every account is demo, cancelled, or already paused).";
  }
  return (
    `Brake engaged. Paused ${result.affectedCount} account(s).` +
    skippedClause(result.intendedCount, result.affectedCount, "were no longer eligible")
  );
}

export function releaseResultMessage(result: { affectedCount: number; intendedCount: number }): string {
  if (result.intendedCount === 0) return "Brake released. No brake-paused accounts to resume.";
  return (
    `Brake released. Resumed ${result.affectedCount} account(s). Accounts paused outside the brake were left paused.` +
    skippedClause(result.intendedCount, result.affectedCount, "were no longer held by the brake")
  );
}
