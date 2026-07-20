// Pure display formatters for the admin surface. Not a `.server.ts` module
// (mirrors app/lib/money-format.ts): both /admin and /admin/operations render
// these client-side too, so they must stay out of any server-only file.

/** Human-readable byte size, used by both /admin and /admin/operations so the
 *  two D1-size displays never drift in formatting. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIndex]}`;
}
