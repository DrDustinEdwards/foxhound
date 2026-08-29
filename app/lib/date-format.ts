// Shared date/time display primitives.
//
// These exist because the product surfaces need three things the codebase had
// no single home for: an absolute short date, an absolute date+time, and a
// FORWARD-looking relative string ("in 3h 20m"). The backward-looking case
// already lives in app/lib/dashboard/recovery-window.ts (formatRelativeTime)
// and is deliberately not duplicated here.
//
// Every formatter pins timeZone: "UTC". Foxhound server-renders on Workers and
// then hydrates in the visitor's browser; an unpinned toLocaleString resolves
// to UTC on the server and to the visitor's local zone on the client, so the
// two renders disagree and React reports a hydration mismatch. Pinning makes
// the string identical on both sides. Existing inline call sites elsewhere in
// the app predate this module and are left alone.

/** "Jan 5, 2026". Empty string for null, so a caller can drop it into JSX
 *  without a branch. */
export function formatDateShort(date: Date | null): string {
  if (!date) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "3d ago" / "5h ago" / "20m ago" / "Just now", and "never" for null.
 *
 *  Ported from legacy lib/format.ts timeAgo, which /help's platform-status
 *  panel renders beside each cron. Legacy reads Date.now() inside the helper;
 *  this takes nowMs so the server and client renders agree, the same reason
 *  every formatter in this module pins its timezone. Distinct from
 *  formatRelativeTime in app/lib/dashboard/recovery-window.ts, which is
 *  day-granularity ("Today" / "Yesterday" / "Nd ago") and would report a cron
 *  that ran twenty minutes ago as "Today". */
export function formatTimeAgo(date: Date | null, nowMs: number): string {
  if (!date) return "never";
  const diff = nowMs - date.getTime();
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.floor(diff / 60_000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "Just now";
}

/** "Jan 5", no year. Empty string for null. For chart axes inside a window
 *  short enough that the year is noise, which is what legacy's Intelligence
 *  charts render (`{ month: "short", day: "numeric", timeZone: "UTC" }`). */
export function formatDateMonthDay(date: Date | null): string {
  if (!date) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Jan 5, 2026, 3:04 PM". Empty string for null. */
export function formatTimestamp(date: Date | null): string {
  if (!date) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Forward-looking relative time, for scheduled work that has not run yet:
 * "due now" once the moment has passed, then "in Nm", "in Nh Nm", "in Nd".
 *
 * The hour form carries minutes because the recovery queue's whole job is
 * telling a merchant how soon the next step fires, and "in 3h" hides up to 59
 * minutes of that. The day form deliberately drops hours: at that distance the
 * extra precision is noise.
 *
 * Returns null for null input so a caller can omit the element entirely.
 */
export function formatRelativeFuture(date: Date | null, nowMs: number): string | null {
  if (!date) return null;
  const deltaMs = date.getTime() - nowMs;
  if (deltaMs <= 0) return "due now";
  if (deltaMs < HOUR_MS) {
    const minutes = Math.max(1, Math.round(deltaMs / MINUTE_MS));
    return `in ${minutes}m`;
  }
  if (deltaMs < DAY_MS) {
    const hours = Math.floor(deltaMs / HOUR_MS);
    const minutes = Math.round((deltaMs - hours * HOUR_MS) / MINUTE_MS);
    // Rounding minutes can reach 60; carry it rather than printing "in 3h 60m".
    if (minutes === 60) return `in ${hours + 1}h`;
    return minutes === 0 ? `in ${hours}h` : `in ${hours}h ${minutes}m`;
  }
  const days = Math.floor(deltaMs / DAY_MS);
  return `in ${days}d`;
}
