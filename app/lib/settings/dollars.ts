// Pure dollar<->cents helpers for settings inputs (e.g. self-reported MRR).
// Not server-only: the component renders formatCentsAsDollars for an input's
// defaultValue, so this must be safe to bundle for the client too.

/** Parse a merchant-entered dollar string into integer cents, or null if blank/invalid. */
export function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const dollars = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

/** Format integer cents back into a plain dollar string for an input's defaultValue. */
export function formatCentsAsDollars(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2);
}
