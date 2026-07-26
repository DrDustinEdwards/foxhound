// Pure half of the global emergency brake: the type-to-confirm phrases and the
// matcher. Deliberately NOT in brake.server.ts, because the phrases are rendered
// in the panel AND validated in the action, and importing a .server module into
// a component body ships the server bundle to the browser (a build break, and a
// secrets problem).

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
