// Constants for the admin surface (the D1 size display), used by BOTH the
// loader and the rendered component on /admin and /admin/operations. Not a
// `.server.ts` module (mirrors app/lib/money/totals.ts): anything a route
// component reads directly (not just its loader) must live outside a
// server-only file, or the RR8/Vite "server-only module referenced by
// client" build check fails (confirmed by CI on this exact mistake with
// D1_CAP_BYTES/D1_ALERT_THRESHOLD, moved here from operations.server.ts).

export const D1_CAP_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB (ARCHITECTURE.md)
export const D1_ALERT_THRESHOLD = 0.5; // alert at 50% of cap
