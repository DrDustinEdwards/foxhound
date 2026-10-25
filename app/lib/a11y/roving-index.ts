/**
 * Roving-tabindex key handling, extracted as a pure function so it can be
 * tested (ruling 209's residue).
 *
 * Legacy's status filter (app/(app)/recovery/payments/components/
 * PaymentsFilters.tsx) is a `role="radiogroup"` whose key handler moves through
 * the options on arrows, wrapping at both ends, and jumps to first and last on
 * Home and End. Foxhound's port has to reproduce that BEHAVIOR, not an
 * approximation of it, so the index arithmetic lives here where a test can
 * reach it: vitest runs `environment: "node"` with no DOM, so a component-level
 * keyboard test is not available without adding jsdom.
 *
 * Returns the index to move to, or null when the key is not one this control
 * handles. Callers use null to decide whether to preventDefault: a key that
 * returns null must fall through to the browser untouched, or the control
 * swallows Tab, typing and shortcuts.
 */
export function nextRovingIndex(key: string, current: number, length: number): number | null {
  if (length <= 0) return null;
  const last = length - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return current >= last ? 0 : current + 1;
    case "ArrowLeft":
    case "ArrowUp":
      return current <= 0 ? last : current - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}
