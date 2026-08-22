/**
 * Bound on an API key's label, in a CLIENT-SAFE module because the form renders
 * it as `maxLength`. Importing it from a `.server` module ships drizzle in this
 * route's client chunk, which the build refuses; the same split
 * `sender-name.ts` and `audit-settings.ts` use.
 *
 * LEGACY HAS NO BOUND: its input is a bare `type="text"` with `required` and
 * nothing else. 80 matches the sender name's bound rather than inventing a
 * second number, and is an ADDITION, not a port.
 */
export const API_KEY_LABEL_MAX_LENGTH = 80;
