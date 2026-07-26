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
 *  phrase. No single-click path exists for any of them. */
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
