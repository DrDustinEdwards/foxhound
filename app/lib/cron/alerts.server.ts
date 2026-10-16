import { escapeHtml } from "capsomer/email";
import { and, desc, eq } from "drizzle-orm";

import type { Db } from "~/db/client";
import { cronAlerts, cronRunHistory } from "~/db/schema";
import {
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_MONTHLY,
  CRON_SCHEDULE_MONTHLY_AUDIT,
  CRON_SCHEDULE_RECOVERY_TICK,
  CRON_SCHEDULE_WEEKLY,
} from "~/lib/constants";
import { sendTransactionalEmail } from "~/lib/email/send";
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
  [CRON_SCHEDULE_WEEKLY]: 7 * 24 * 60 * 60 * 1000,
  [CRON_SCHEDULE_DAILY]: 24 * 60 * 60 * 1000,
  [CRON_SCHEDULE_MONTHLY]: 31 * 24 * 60 * 60 * 1000,
  // The merged monthly audit's own hour (362 ruling 3). Mapped at the same
  // period as the other monthly jobs: a schedule missing from this map is
  // reported as `unknown_schedule`, which is a blind spot rather than an alert,
  // so a new expression that skips this line silently stops being watched.
  [CRON_SCHEDULE_MONTHLY_AUDIT]: 31 * 24 * 60 * 60 * 1000,
};

/** A job may miss this many periods before it is called stale. Two rather than
 *  one, because a single skipped tick is normal (a lock held, a not-due skip)
 *  and alerting on it would train the reader to ignore the alert. */
export const STALE_PERIOD_MULTIPLIER = 2;

export interface JobSchedule {
  name: string;
  schedule: string;
}

export interface StaleFinding {
  cronName: string;
  /** null when the job has NEVER run, which is the billing-monthly case. */
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
  lastSuccessAt: Date | null;
}

/** The email body. Named separately so its content is assertable without
 *  sending anything. Carries what a human needs to act: which cron, which run,
 *  what the error said, and when it last worked. */
export function buildFailureAlertEmail(input: FailureAlertInput, now: Date): {
  subject: string;
  bodyHtml: string;
} {
  const lastSuccess = input.lastSuccessAt
    ? input.lastSuccessAt.toISOString()
    : "never (no successful run on record)";
  // EVERY interpolated value is escaped (job_17249e7da871): the error can carry
  // Stripe or model text, and the cron name and run id are data as well. The
  // subject is a header, not HTML, so it stays as given.
  const cronName = escapeHtml(input.cronName);
  const runId = escapeHtml(input.runId ?? "unrecorded");
  const error = escapeHtml(input.error ?? "no message recorded");
  return {
    subject: `Foxhound cron FAILED: ${input.cronName}`,
    bodyHtml: [
      `<p><strong>${cronName}</strong> failed at ${now.toISOString()}.</p>`,
      `<p>Run id: ${runId}</p>`,
      `<p>Error: ${error}</p>`,
      `<p>Last success: ${escapeHtml(lastSuccess)}</p>`,
      `<p>One alert per cron per day. Check /admin/operations for the run history.</p>`,
    ].join("\n"),
  };
}

export function buildStaleAlertEmail(finding: StaleFinding, now: Date): {
  subject: string;
  bodyHtml: string;
} {
  const last = finding.lastRunAt ? finding.lastRunAt.toISOString() : "never";
  const why =
    finding.reason === "never_run"
      ? "It has NEVER run."
      : finding.reason === "unknown_schedule"
        ? "Its schedule is not mapped to a period, so staleness cannot be judged."
        : "It is overdue against its schedule.";
  return {
    subject: `Foxhound cron STALE: ${finding.cronName}`,
    bodyHtml: [
      `<p><strong>${escapeHtml(finding.cronName)}</strong> looks stale at ${now.toISOString()}.</p>`,
      `<p>${escapeHtml(why)}</p>`,
      `<p>Last run: ${escapeHtml(last)}</p>`,
    ].join("\n"),
  };
}

/** Send one alert, deduped, never throwing. */
export async function sendAlert(
  env: Env,
  db: Db,
  cronName: string,
  kind: AlertKind,
  message: { subject: string; bodyHtml: string },
  now: Date,
): Promise<AlertOutcome> {
  const claimed = await claimAlertSlot(db, cronName, kind, now, message.subject);
  if (!claimed) return { sent: false, reason: "deduped" };

  try {
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
export async function lastSuccessAt(db: Db, cronName: string): Promise<Date | null> {
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
export const DEAD_LETTER_ALERT_KEY = "email-dead-letters";

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
  // Last run per cron, whatever its status: a job that ran and FAILED is not
  // stale, it is failing, and the failure alert already covers that. Staleness
  // is about absence.
  const lastRuns = new Map<string, Date | null>();
  for (const job of jobs) {
    const row = (
      await db
        .select({ finishedAt: cronRunHistory.finishedAt })
        .from(cronRunHistory)
        .where(eq(cronRunHistory.cronName, job.name))
        .orderBy(desc(cronRunHistory.finishedAt))
        .limit(1)
    )[0];
    lastRuns.set(job.name, row?.finishedAt ?? null);
  }

  const stale = findStaleCrons(jobs, lastRuns, now);
  let alerted = 0;
  const deduped: string[] = [];

  for (const finding of stale) {
    const outcome = await sendAlert(
      env,
      db,
      finding.cronName,
      "stale",
      buildStaleAlertEmail(finding, now),
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
  input: { cronName: string; runId: string | null; error: string | null },
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
