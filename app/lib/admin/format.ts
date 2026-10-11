// Pure display formatters + constants for the admin surface, used by BOTH the
// loader and the rendered component on /admin and /admin/operations. Not a
// `.server.ts` module (mirrors app/lib/money-format.ts): anything a route
// component reads directly (not just its loader) must live outside a
// server-only file, or the RR8/Vite "server-only module referenced by
// client" build check fails (confirmed by CI on this exact mistake with
// D1_CAP_BYTES/D1_ALERT_THRESHOLD, moved here from operations.server.ts).

export const D1_CAP_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB (ARCHITECTURE.md)
export const D1_ALERT_THRESHOLD = 0.5; // alert at 50% of cap

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
  // Rounded, then trailing zeros dropped: "876 KB", "1.5 MB", "2.25 GB", never
  // "876.0 KB" (Dustin's review, 2026-10-11).
  const rounded = Number(value.toFixed(value < 10 ? 2 : 1));
  return `${rounded} ${units[unitIndex]}`;
}
