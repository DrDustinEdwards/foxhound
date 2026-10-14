// Pure display helpers for /admin/crons and the Overview's cron health, shared
// by both pages (not a .server module: the components render them).

/** The element id of one run on /admin/crons. */
export function cronRunAnchor(runId: string): string {
  return `run-${runId}`;
}

/** Where a run is shown: on its cron, on /admin/crons. The Overview links every
 *  failed run here. */
export function cronRunHref(runId: string): string {
  return `/admin/crons#${cronRunAnchor(runId)}`;
}

/** The element id of one cron's card on /admin/crons. */
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
 *   "0 8 * * 1"    -> "Mondays at 08:00 UTC"
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
  if (dayOfMonth === "*" && isInt(dayOfWeek, 0, 7)) return `${WEEKDAYS[Number(dayOfWeek) % 7]}s at ${at}`;
  if (isInt(dayOfMonth, 1, 31) && dayOfWeek === "*") return `Monthly on the ${ordinal(Number(dayOfMonth))} at ${at}`;
  return null;
}
