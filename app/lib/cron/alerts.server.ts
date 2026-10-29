import { and, desc, eq } from "drizzle-orm";

import type { Db } from "~/db/client";
import { cronAlerts, cronRunHistory } from "~/db/schema";
import {
  CRON_SCHEDULE_BLOG,
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_MONTHLY_AUDIT,
  CRON_SCHEDULE_RECOVERY_TICK,
  CRON_SCHEDULE_WEEKLY,
  DAY_MS,
} from "~/lib/constants";
import { sendRenderedTransactionalEmail, sendTransactionalEmail } from "~/lib/email/send";
import {
  manageEmailSettingsLine,
  recoveryFooterNote,
  renderFoxhoundAlertEmail,
  type EmailAlert,
} from "~/lib/email/templates";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";

/** Cron-failure alerting (313). Ruling 311 measured that a failing cron records
 *  `status: "failed"` to cron_run_history and notifies NOBODY, so a job that
 *  fails every run fails silently until somebody opens /admin/operations. That
 *  matters most for billing-monthly, which has never executed once in any
 *  environment and whose first real run is a supervised event.
 *
 *  CHANNEL: email to SUPPORT_EMAIL through the existing transactional sender, so
 *  ZERO new credentials. 312 ruled the channel.
 *
 *  THE FAILURE-MODE OVERLAP IS REAL AND ACCEPTED (312): this alerts about an
 *  email-adjacent system BY EMAIL, so a total email outage silences its own
 *  alarm. Stated rather than glossed. It is still strictly better than the
 *  nothing that preceded it: cron failures are not usually email failures, and
 *  the dead-letter alert in particular fires on a path where the queue, not the
 *  sender, is the thing that broke.
 *
 *  FAIL-OPEN, ALWAYS: the alerting path must never take down the cron it
 *  observes. Every send is caught, its outcome returned for the caller to
 *  record, and never rethrown. An observability tool that can fail a money job
 *  is worse than no observability. */

export type AlertKind = "failure" | "stale" | "dead_letter";

export type AlertOutcome =
  | { sent: true }
  | { sent: false; reason: "deduped" }
  | { sent: false; reason: "send_failed"; error: string };

/** UTC calendar day, the day-granularity half of the dedupe key. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** How long each schedule may go without a run before it is STALE.
 *
 *  The JOBS come from the registry, never a hand list, which is what 313
 *  required. This table maps a SCHEDULE to its period, which is unavoidable
 *  without a cron-expression parser (a dependency, and adding one is a build
 *  decision rather than an agent's). A schedule absent from this table is
 *  REPORTED as unknown rather than silently treated as healthy, so adding a
 *  fourth schedule surfaces here instead of creating a blind spot.
 *
 *  THAT SURFACING IS A DAILY LINE IN A TABLE NOBODY READS, and 376 item 15 is
 *  the proof: the weekly schedule was missing here for the whole life of the
 *  weekly digest and the blind spot reported itself, correctly, into the void.
 *  The guard that actually closes it is a test that derives this table's keys
 *  from the registry's schedules, so the gap fails a build instead. Exported for
 *  that test, which is the only reason this is not module-private. */
export const SCHEDULE_PERIOD_MS: Record<string, number> = {
  [CRON_SCHEDULE_RECOVERY_TICK]: 5 * 60 * 1000,
  // THE WEEKLY DIGEST'S SCHEDULE (376 item 15). It was missing from this table
  // from the day session 55 added the repo's first new cron expression, so
  // cron-health reported weekly-digest as `unknown_schedule` every day since:
  // the one job in the registry that this table could not answer for.
  //
  // The comment three lines below predicted exactly this and did not prevent it,
  // which is why the parity plant now derives the schedule set from the registry
  // rather than trusting a warning to be read.
  [CRON_SCHEDULE_WEEKLY]: 7 * DAY_MS,
  [CRON_SCHEDULE_DAILY]: DAY_MS,
  [CRON_SCHEDULE_MONTHLY]: 31 * DAY_MS,
  // The merged monthly audit's own hour (362 ruling 3). Mapped at the same
  // period as the other monthly jobs: a schedule missing from this map is
  // reported as `unknown_schedule`, which is a blind spot rather than an alert,
  // so a new expression that skips this line silently stops being watched.
  [CRON_SCHEDULE_MONTHLY_AUDIT]: 31 * DAY_MS,
  // Every minute, judged at five: the daily check runs on its own trigger, and
  // a tick skipped on the lock is normal, so a one-minute period would alert on
  // a healthy job.
  [CRON_SCHEDULE_BLOG]: 5 * 60 * 1000,
};

/** A job may miss this many periods before it is called stale. Two rather than
 *  one, because a single skipped tick is normal (a lock held, a not-due skip)
 *  and alerting on it would train the reader to ignore the alert. */
const STALE_PERIOD_MULTIPLIER = 2;

/** Each schedule's cadence in words, for the stale alert's subject and body
 *  (E27). Recova's check-cron-health keeps a hand label per cron in the same
 *  style ("hourly", "daily 02:00 UTC", "weekly (Mon 08:00 UTC)", "monthly (1st
 *  10:00 UTC)") so an operator can triage without cross-referencing
 *  schedules; Foxhound's are keyed by its own schedules, and a test holds every
 *  schedule the registry uses to a label. */
const CADENCE_LABEL: Record<string, string> = {
  [CRON_SCHEDULE_RECOVERY_TICK]: "every 5 min",
  [CRON_SCHEDULE_DAILY]: "daily 03:00 UTC",
  [CRON_SCHEDULE_WEEKLY]: "weekly (Mon 08:00 UTC)",
  [CRON_SCHEDULE_MONTHLY]: "monthly (1st 04:00 UTC)",
  [CRON_SCHEDULE_MONTHLY_AUDIT]: "monthly (1st 09:00 UTC)",
  [CRON_SCHEDULE_BLOG]: "every minute",
};

/** Recova's describeAge (check-cron-health/route.ts), its units and its floor
 *  as written, "1 hours ago" included. Pure. */
export function describeAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

export interface JobSchedule {
  name: string;
  schedule: string;
}

export interface StaleFinding {
  cronName: string;
  /** The last SUCCESSFUL run as runCronHealthCheck passes it (Recova's
   *  last_succeeded_at); null when the job has never succeeded, which is the
   *  billing-monthly case. */
  lastRunAt: Date | null;
  reason: "never_run" | "overdue" | "unknown_schedule";
}

/** Pure: which registered jobs look stale, given their last run times. */
export function findStaleCrons(
  jobs: JobSchedule[],
  lastRunByCron: Map<string, Date | null>,
  now: Date,
): StaleFinding[] {
  const out: StaleFinding[] = [];
  for (const job of jobs) {
    const period = SCHEDULE_PERIOD_MS[job.schedule];
    const lastRunAt = lastRunByCron.get(job.name) ?? null;

    if (period === undefined) {
      // Loud rather than skipped: an unmapped schedule is a blind spot.
      out.push({ cronName: job.name, lastRunAt, reason: "unknown_schedule" });
      continue;
    }
    if (lastRunAt === null) {
      out.push({ cronName: job.name, lastRunAt: null, reason: "never_run" });
      continue;
    }
    if (now.getTime() - lastRunAt.getTime() > period * STALE_PERIOD_MULTIPLIER) {
      out.push({ cronName: job.name, lastRunAt, reason: "overdue" });
    }
  }
  return out;
}

/** Claim the one-per-cron-per-kind-per-day slot. TRUE means this caller may
 *  send. The claim is a unique-index insert, so two concurrent cron invocations
 *  cannot both win: the database refuses the second, not a read-then-write in
 *  application code that could interleave. */
export async function claimAlertSlot(
  db: Db,
  cronName: string,
  kind: AlertKind,
  now: Date,
  detail?: string,
): Promise<boolean> {
  try {
    await db.insert(cronAlerts).values({
      id: crypto.randomUUID(),
      cronName,
      kind,
      alertedOn: utcDay(now),
      detail: detail ?? null,
      createdAt: now,
    });
    return true;
  } catch {
    // The unique index rejected it: already alerted today for this cron+kind.
    return false;
  }
}

export interface FailureAlertInput {
  cronName: string;
  runId: string | null;
  error: string | null;
  /** The error's stack, when the failure was a thrown Error. */
  stack?: string | null;
  lastSuccessAt: Date | null;
}

/** An alert's content before it is rendered: its subject and Capsomer alert. */
export interface CronAlertMessage {
  subject: string;
  alert: EmailAlert;
}

/** Recova's subject tag: "[Recova Ops]", Foxhound's name (E26, E27). */
const OPS_TAG = "[Foxhound Ops]";
/** The sender wrapEmailHtml names in the footer: Recova's 'Recova Ops'. */
const OPS_SENDER_NAME = "Foxhound Ops";
/** Recova's stack excerpt length: `error.stack.slice(0, 500)`. */
const STACK_EXCERPT_CHARS = 500;

/**
 * The cron failure alert (E26): Recova's notifyCronFailure subject and body,
 * Foxhound's name, then Foxhound's run id and last success, which say which
 * run is on the record and when the cron last worked. Recova's bold labels
 * ("Message:") are plain text (Capsomer job_2adddfaab5dc, bold runs), and its
 * stack <pre> is one paragraph per line (Capsomer gap named in the PR). Pure.
 */
export function buildFailureAlertEmail(input: FailureAlertInput, now: Date): CronAlertMessage {
  const subject = `${OPS_TAG} Cron failure: ${input.cronName}`;
  const stackLines = input.stack
    ? input.stack
        .slice(0, STACK_EXCERPT_CHARS)
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0)
    : [];
  const lastSuccess = input.lastSuccessAt
    ? input.lastSuccessAt.toISOString()
    : "never (no successful run on record)";
  return {
    subject,
    alert: {
      level: "crit",
      title: subject,
      intro: `The ${input.cronName} cron failed.`,
      when: now.toISOString(),
      details: [
        `Message: ${input.error ?? "no message recorded"}`,
        ...(stackLines.length > 0 ? ["Stack (first 500 chars):", ...stackLines] : []),
        `Failed at ${now.toISOString()} UTC.`,
        `Run id: ${input.runId ?? "unrecorded"}`,
        `Last success: ${lastSuccess}`,
      ],
    },
  };
}

/**
 * The cron stale alert (E27): Recova's notifyCronStale subject, with the age
 * and the cadence, and its body, Foxhound's name. Recova's "Check Vercel cron
 * logs and the cron_runs table." names Recova's host and table; Foxhound's
 * pointer names its own page and table. Pure.
 */
export function buildStaleAlertEmail(
  finding: StaleFinding & { schedule: string },
  now: Date,
): CronAlertMessage {
  const agePhrase = finding.lastRunAt
    ? `last succeeded ${describeAge(now.getTime() - finding.lastRunAt.getTime())}`
    : "never succeeded";
  const cadence = CADENCE_LABEL[finding.schedule];
  const cadenceSuffix = cadence ? `, expected ${cadence}` : "";
  const subject = `${OPS_TAG} Cron stale: ${finding.cronName} (${agePhrase}${cadenceSuffix})`;
  return {
    subject,
    alert: {
      level: "warn",
      title: subject,
      intro: `The ${finding.cronName} cron has not reported a successful run within its expected interval.`,
      when: now.toISOString(),
      details: [
        `Last succeeded: ${finding.lastRunAt ? finding.lastRunAt.toISOString() : "(never)"}`,
        `Age: ${agePhrase}`,
        ...(cadence ? [`Expected cadence: ${cadence}`] : []),
        "Check /admin/operations and the cron_run_history table.",
      ],
    },
  };
}

/**
 * The per-account billing failure (E26's second trigger): Recova's
 * process-recovery-billing alerts when any account fails to invoice, naming the
 * count, the month and the accounts. Its second sentence names Recova's
 * billing_assessments table and promises a rerun; it is left out here and
 * asked about in the PR. Null when no account failed. Pure.
 */
export function billingFailureError(failedAccountIds: string[], periodStart: Date): string | null {
  if (failedAccountIds.length === 0) return null;
  const monthLabel = periodStart.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return `${failedAccountIds.length} account(s) failed to invoice for ${monthLabel}: ${failedAccountIds.join(", ")}.`;
}

/** Send one alert, deduped, never throwing. A cron alert (E26, E27) goes on
 *  Capsomer's alert template with Recova's footer; the dead-letter alert,
 *  Foxhound's own, keeps its HTML body. */
export async function sendAlert(
  env: Env,
  db: Db,
  cronName: string,
  kind: AlertKind,
  message: { subject: string; bodyHtml: string } | CronAlertMessage,
  now: Date,
): Promise<AlertOutcome> {
  const claimed = await claimAlertSlot(db, cronName, kind, now, message.subject);
  if (!claimed) return { sent: false, reason: "deduped" };

  try {
    if ("alert" in message) {
      // Recova's footer as wrapEmailHtml(body, 'Recova Ops') writes it with no
      // unsubscribe token: its sentence, then Manage email settings.
      const rendered = renderFoxhoundAlertEmail({
        subject: message.subject,
        to: SUPPORT_EMAIL,
        alert: message.alert,
        footer: [
          recoveryFooterNote(OPS_SENDER_NAME, now.getUTCFullYear()),
          manageEmailSettingsLine(env.BETTER_AUTH_URL ?? ""),
        ],
      });
      const outcome = await sendRenderedTransactionalEmail(env, { to: SUPPORT_EMAIL, rendered });
      if (outcome.status === "sent") return { sent: true };
      return { sent: false, reason: "send_failed", error: outcome.error ?? outcome.reason };
    }
    await sendTransactionalEmail(env, {
      to: SUPPORT_EMAIL,
      subject: message.subject,
      bodyHtml: message.bodyHtml,
    });
    return { sent: true };
  } catch (err) {
    // SWALLOWED BY DESIGN. The caller records this; the cron carries on.
    return {
      sent: false,
      reason: "send_failed",
      error: err instanceof Error ? err.message : "alert send failed",
    };
  }
}

/** The last successful run of a cron, for the failure email's context. */
async function lastSuccessAt(db: Db, cronName: string): Promise<Date | null> {
  const row = (
    await db
      .select({ finishedAt: cronRunHistory.finishedAt })
      .from(cronRunHistory)
      .where(and(eq(cronRunHistory.cronName, cronName), eq(cronRunHistory.status, "success")))
      .orderBy(desc(cronRunHistory.finishedAt))
      .limit(1)
  )[0];
  return row?.finishedAt ?? null;
}

/** The dead-letter alert (313 build B). Shares the dedupe mechanism with the cron
 *  alerts, keyed on the pseudo-cron name below, so a burst of dead letters raises
 *  ONE email per day rather than one per message.
 *
 *  Named as a cron for dedupe purposes even though the queue, not a cron, is what
 *  failed: the dedupe table is keyed (cron_name, kind, day), and reusing it beats
 *  inventing a second dedupe store for the same job. */
const DEAD_LETTER_ALERT_KEY = "email-dead-letters";

export async function alertDeadLetters(
  env: Env,
  db: Db,
  counts: { written: number; failed: number },
  now: Date,
): Promise<AlertOutcome> {
  if (counts.written === 0 && counts.failed === 0) return { sent: false, reason: "deduped" };
  try {
    return await sendAlert(
      env,
      db,
      DEAD_LETTER_ALERT_KEY,
      "dead_letter",
      {
        subject: "Foxhound dunning emails DEAD-LETTERED",
        bodyHtml: [
          `<p>${counts.written} dunning email(s) exhausted their queue retries and were dead-lettered at ${now.toISOString()}.</p>`,
          counts.failed
            ? `<p>${counts.failed} dead letter(s) could not even be recorded.</p>`
            : "",
          `<p>Query email_dead_letters for the rows. One alert per day.</p>`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      now,
    );
  } catch (err) {
    return {
      sent: false,
      reason: "send_failed",
      error: err instanceof Error ? err.message : "dead-letter alert failed",
    };
  }
}

/** The never-executed and overdue detector, as a cron handler.
 *
 *  TAKES ITS JOBS AS A PARAMETER rather than importing the registry, which would
 *  be circular: the registry imports this module to register the check. The
 *  caller passes CRON_JOBS, so the expectations are still DERIVED from the
 *  registry and never from a hand list, which is what 313 required.
 *
 *  It reports rather than throws: a health check that fails the run it is
 *  reporting on would be its own worst finding. */
export async function runCronHealthCheck(
  env: Env,
  db: Db,
  jobs: JobSchedule[],
  now: Date,
): Promise<{ rowsProcessed: number; message: string }> {
  // Last SUCCESSFUL run per cron (E27): Recova's watcher reads
  // last_succeeded_at, so a cron that keeps running and failing is stale as
  // well as failing, and both alerts go.
  const lastRuns = new Map<string, Date | null>();
  for (const job of jobs) {
    lastRuns.set(job.name, await lastSuccessAt(db, job.name));
  }

  const stale = findStaleCrons(jobs, lastRuns, now);
  const scheduleOf = new Map(jobs.map((j) => [j.name, j.schedule]));
  let alerted = 0;
  const deduped: string[] = [];

  for (const finding of stale) {
    // An unmapped schedule is reported in the run's message and not emailed:
    // Recova alerts only on the crons in its schedule list, and a test holds
    // every registry schedule to a period, so this is a blind spot the build
    // catches rather than a stale cron.
    if (finding.reason === "unknown_schedule") continue;
    const outcome = await sendAlert(
      env,
      db,
      finding.cronName,
      "stale",
      buildStaleAlertEmail({ ...finding, schedule: scheduleOf.get(finding.cronName) ?? "" }, now),
      now,
    );
    if (outcome.sent) alerted += 1;
    else if (outcome.reason === "deduped") deduped.push(finding.cronName);
  }

  const names = stale.map((s) => `${s.cronName}(${s.reason})`).join(", ");
  return {
    rowsProcessed: stale.length,
    message: stale.length
      ? `${stale.length} stale: ${names}; ${alerted} alerted, ${deduped.length} deduped`
      : "all crons within tolerance",
  };
}

/** The whole failure path: look up context, dedupe, send, never throw. */
export async function alertCronFailure(
  env: Env,
  db: Db,
  input: { cronName: string; runId: string | null; error: string | null; stack?: string | null },
  now: Date,
): Promise<AlertOutcome> {
  try {
    const last = await lastSuccessAt(db, input.cronName);
    const message = buildFailureAlertEmail({ ...input, lastSuccessAt: last }, now);
    return await sendAlert(env, db, input.cronName, "failure", message, now);
  } catch (err) {
    // Even the CONTEXT LOOKUP is inside the swallow: a database hiccup while
    // building an alert must not fail the cron that is already failing.
    return {
      sent: false,
      reason: "send_failed",
      error: err instanceof Error ? err.message : "alert path failed",
    };
  }
}
