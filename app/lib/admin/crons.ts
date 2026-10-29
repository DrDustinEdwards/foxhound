// Pure display helpers for /admin/platform/crons and the Overview's cron health, shared
// by both pages (not a .server module: the components render them).

/** The element id of one run on /admin/platform/crons. */
export function cronRunAnchor(runId: string): string {
  return `run-${runId}`;
}

/** Where a run is shown: on its cron, on /admin/platform/crons. The Overview links every
 *  failed run here. */
export function cronRunHref(runId: string): string {
  return `/admin/platform/crons#${cronRunAnchor(runId)}`;
}

/** The element id of one cron's card on /admin/platform/crons. */
export function cronAnchor(cronName: string): string {
  return `cron-${cronName}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** The 0-based (Sunday first) weekday of a cron day-of-week field, as
 *  Cloudflare reads it: SUN..SAT, or 1 = Sunday to 7 = Saturday. */
export function cronWeekdayIndex(field: string): number | null {
  const named = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].indexOf(field.toUpperCase());
  if (named !== -1) return named;
  if (!isInt(field, 1, 7)) return null;
  return Number(field) - 1;
}

function isInt(field: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(field)) return false;
  const n = Number(field);
  return n >= min && n <= max;
}

/**
 * A cron expression in plain words, for the shapes Foxhound schedules: every N
 * minutes, daily, weekly on a day and monthly on a date, all at a UTC time.
 * Cloudflare runs cron triggers in UTC, so the words say UTC. Any other shape
 * returns null and the page shows the expression alone rather than a guess.
 *
 *   "*\/5 * * * *"  -> "Every 5 minutes"
 *   "0 3 * * *"    -> "Daily at 03:00 UTC"
 *   "0 8 * * MON"  -> "Mondays at 08:00 UTC"
 *
 * A numeric weekday is read as Cloudflare numbers it, 1 = Sunday to 7 = Saturday.
 *   "0 4 1 * *"    -> "Monthly on the 1st at 04:00 UTC"
 */
export function describeCronSchedule(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  const every = /^\*\/(\d+)$/.exec(minute);
  if (every && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const n = Number(every[1]);
    if (n < 1 || n > 59) return null;
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }
  if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Every minute";
  }

  if (!isInt(minute, 0, 59) || !isInt(hour, 0, 23) || month !== "*") return null;
  const at = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC`;

  if (dayOfMonth === "*" && dayOfWeek === "*") return `Daily at ${at}`;
  const weekday = cronWeekdayIndex(dayOfWeek);
  if (dayOfMonth === "*" && weekday !== null) return `${WEEKDAYS[weekday]}s at ${at}`;
  if (isInt(dayOfMonth, 1, 31) && dayOfWeek === "*") return `Monthly on the ${ordinal(Number(dayOfMonth))} at ${at}`;
  return null;
}

/** The Crons page. */
export const CRONS_PATH = "/admin/platform/crons";

/** The confirm page that enables one switched-off cron (it needs the cron's
 *  typed phrase; APPROVED-DIFFERENCES, 2026-09-19). */
export function cronEnableHref(cronName: string): string {
  return `${CRONS_PATH}?enable=${encodeURIComponent(cronName)}`;
}

/** "19 scheduled jobs, 1 switched off.", "1 scheduled job, none switched off." */
export function cronsSummaryWords(total: number, switchedOff: number): string {
  const jobs = total === 1 ? "1 scheduled job" : `${total} scheduled jobs`;
  return `${jobs}, ${switchedOff === 0 ? "none" : switchedOff} switched off.`;
}

/** "1 failed run in the last 24 hours", "3 failed runs in the last 24 hours". */
export function failedRunsWords(count: number): string {
  return count === 1 ? "1 failed run in the last 24 hours" : `${count} failed runs in the last 24 hours`;
}
