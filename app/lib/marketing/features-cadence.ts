import {
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_EXPIRING_CARDS,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_MONTHLY_AUDIT,
  CRON_SCHEDULE_RECOVERY_TICK,
  CRON_SCHEDULE_WEEKLY,
} from "~/lib/constants";
import { cronWeekdayIndex } from "~/lib/admin/crons";
import { ordinal } from "~/lib/billing/page";
import { capitalize, plural } from "@drdustinedwards/site-helpers/text";

function cronEveryMinutes(expr: string): number {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(expr);
  if (!m) throw new Error(`not an every-N-minutes schedule: ${expr}`);
  return Number(m[1]);
}

function cronIsDaily(expr: string): boolean {
  return /^\d+ \d+ \* \* \*$/.test(expr);
}

/** The cadence word for a schedule: "nightly" for a daily run (daily jobs run at night, UTC), "weekly", "monthly", or "every N minutes". */
function cronCadence(expr: string): string {
  if (/^\*\/\d+ \* \* \* \*$/.test(expr)) return `every ${cronEveryMinutes(expr)} minutes`;
  if (cronIsDaily(expr)) return "nightly";
  if (/^\d+ \d+ \* \* \w+$/.test(expr)) return "weekly";
  if (/^\d+ \d+ \d+ \* \*$/.test(expr)) return "monthly";
  throw new Error(`no cadence word for schedule: ${expr}`);
}

/** When in its period a schedule runs: "the 1st of each month", "each Tuesday", "each night". */
function cronWhen(expr: string): string {
  const cadence = cronCadence(expr);
  if (cadence === "monthly") return `the ${ordinal(cronMonthDay(expr))} of each month`;
  if (cadence === "weekly") return `each ${cronWeekday(expr)}`;
  if (cadence === "nightly") return "each night";
  return cadence;
}

function cronMonthDay(expr: string): number {
  const m = /^\d+ \d+ (\d+) \* \*$/.exec(expr);
  if (!m) throw new Error(`not a monthly schedule: ${expr}`);
  return Number(m[1]);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function cronWeekday(expr: string): string {
  const m = /^\d+ \d+ \* \* (\w+)$/.exec(expr);
  const day = m ? cronWeekdayIndex(m[1]) : null;
  if (day === null) throw new Error(`not a weekly schedule: ${expr}`);
  return WEEKDAYS[day];
}

export function minutesText(minutes: number): string {
  return minutes % 60 === 0 ? plural(minutes / 60, "hour") : plural(minutes, "minute");
}

export function featureCadence() {
  const tick = cronEveryMinutes(CRON_SCHEDULE_RECOVERY_TICK);
  const billingWhen = cronWhen(CRON_SCHEDULE_MONTHLY);
  const auditWhen = cronWhen(CRON_SCHEDULE_MONTHLY_AUDIT);
  const digestDay = cronWeekday(CRON_SCHEDULE_WEEKLY);
  // Each cadence word is read from the schedule its job runs on (the cron registry pairs job and schedule).
  const nightly = cronCadence(CRON_SCHEDULE_DAILY);
  const Nightly = capitalize(nightly);
  // Expiring cards run on their own schedule.
  const CardsCadence = capitalize(
    cronIsDaily(CRON_SCHEDULE_EXPIRING_CARDS) ? "daily" : cronCadence(CRON_SCHEDULE_EXPIRING_CARDS),
  );
  const daily = cronIsDaily(CRON_SCHEDULE_DAILY) ? "daily" : cronCadence(CRON_SCHEDULE_DAILY);
  const monthly = cronCadence(CRON_SCHEDULE_MONTHLY);
  const Monthly = capitalize(monthly);
  const auditCadence = cronCadence(CRON_SCHEDULE_MONTHLY_AUDIT);
  return {
    tick,
    billingWhen,
    auditWhen,
    digestDay,
    nightly,
    Nightly,
    CardsCadence,
    daily,
    monthly,
    Monthly,
    auditCadence,
  };
}

export type FeatureCadence = ReturnType<typeof featureCadence>;
