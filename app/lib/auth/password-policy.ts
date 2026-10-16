// The password rule Better Auth enforces, in a module with no imports, so the
// sign-up and reset pages can state it in the browser bundle without pulling
// Better Auth's options in with it (RULES.md 4.5).

/** Minimum password length at signup and reset (legacy parity: strong-by-default). */
export const MIN_PASSWORD_LENGTH = 12;
