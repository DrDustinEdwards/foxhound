import { appOrigin } from "~/lib/app-origin";
// Recova's describeAge (check-cron-health/route.ts), its units and its floor as written, "1 hours ago" included.
import {
  alertOnce,
  cronAlert,
  describeAge,
  type AlertOutcome,
} from "@dustinedwards/site-runtime/cron-alert";
import { and, desc, eq, ne } from "drizzle-orm";

import type { Db } from "~/db/client";
import { cronRunLog, cronRuns } from "~/db/schema";
import { cronRunId } from "~/lib/admin/crons";
import {
  CRON_SCHEDULE_BLOG,
  CRON_SCHEDULE_DAILY,
  CRON_SCHEDULE_EXPIRING_CARDS,
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
import type { Rendered } from "capsomer/email";
import { SUPPORT_EMAIL } from "~/lib/seo/jsonld";

/** Cron-failure alerting. Ruling 311 measured that a failing cron records
 *  a failed run and notifies NOBODY, so a job that
 *  fails every run fails silently until somebody opens /admin/operations. That
 *  matters most for billing-monthly, which has never executed once in any
 *  environment and whose first real run is a supervised event.
 *
 *  CHANNEL: email to SUPPORT_EMAIL through the existing transactional sender, so
 *  ZERO new credentials. 312 ruled the channel.
 *
 *  THE FAILURE-MODE OVERLAP IS REAL AND ACCEPTED: this alerts about an
 *  email-adjacent system BY EMAIL, so a total email outage silences its own
 *  alarm. Stated rather than glossed. It is still strictly better than the
 *  nothing that preceded it: cron failures are not usually email failures, and
 *  the dead-letter alert in particular fires on a path where the queue, not the
 *  sender, is the thing that broke.
 *
 *  FAIL-OPEN, ALWAYS: the alerting path must never take down the cron it
 *  observes. Every send is caught, its outcome returned for the caller to
 *  record, and never rethrown. An observability tool that can fail a money job
 *  is worse than no observability.
 *
 *  SHARED: the once-a-day dedupe (claim the day's slot in `alerts_sent`, send,
 *  give the slot back when the send did not go) is site-runtime's alertOnce, and
 *  which jobs are failing or stale is its cronAlert over `cron_runs`. What stays
 *  here is Foxhound's own: the mails (Recova's words on Capsomer's alert
 *  template), the dead-letter alert, the schedule table. */

type AlertKind = "failure" | "stale" | "dead_letter";
export type { AlertOutcome };

/** How long each schedule may go without a run before it is STALE.
 *
 *  The JOBS come from the registry, never a hand list, which is what 313
 *  required. This table maps a SCHEDULE to its period, which is unavoidable
 *  without a cron-expression parser (a dependency, and adding one is a build
 *  decision rather than an agent's).
 *
 *  A schedule missing here is a blind spot, and 376 item 15 is the proof: the
 *  weekly schedule was missing for the whole life of the weekly digest and its
 *  only report was a daily line nobody read. The guard is a test that derives
 *  this table's keys from the registry's schedules, so the gap fails a build. Exported for
 *  that test, which is the only reason this is not module-private. */
export const SCHEDULE_PERIOD_MS: Record<string, number> = {
  [CRON_SCHEDULE_RECOVERY_TICK]: 5 * 60 * 1000,
  [CRON_SCHEDULE_WEEKLY]: 7 * DAY_MS,
  [CRON_SCHEDULE_DAILY]: DAY_MS,
  [CRON_SCHEDULE_MONTHLY]: 31 * DAY_MS,
  // The merged monthly audit's own hour, at the other monthly jobs' period.
  [CRON_SCHEDULE_MONTHLY_AUDIT]: 31 * DAY_MS,
  // The expiring-card alert at legacy's 09:00 (parity gap 11). Daily, so a day.
  [CRON_SCHEDULE_EXPIRING_CARDS]: DAY_MS,
  // Every minute, judged at five: the daily check runs on its own trigger, and
  // a tick skipped on the lock is normal, so a one-minute period would alert on
  // a healthy job.
  [CRON_SCHEDULE_BLOG]: 5 * 60 * 1000,
};

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
  [CRON_SCHEDULE_EXPIRING_CARDS]: "daily 09:00 UTC",
  [CRON_SCHEDULE_BLOG]: "every minute",
};

export interface JobSchedule {
  name: string;
  schedule: string;
}

/** A job the health check found not well, for the stale mail. */
export interface StaleFinding {
  cronName: string;
  /** The last success (cron_runs.last_ok_at); null when it never succeeded,
   *  which is the billing-monthly case. */
  lastRunAt: Date | null;
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
 * ("Message:") are plain text (bold runs), and its
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
        "Check /admin/platform/crons and the cron_run_log table.",
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
  const monthLabel = periodStart.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${failedAccountIds.length} account(s) failed to invoice for ${monthLabel}: ${failedAccountIds.join(", ")}.`;
}

/** A cron alert (E26, E27) on Capsomer's alert template, with Recova's footer
 *  as wrapEmailHtml(body, 'Recova Ops') writes it with no unsubscribe token:
 *  its sentence, then Manage email settings. Pure; the admin email preview
 *  renders through it too. */
export function renderCronAlertEmail(
  to: string,
  message: CronAlertMessage,
  baseUrl: string,
  now: Date,
): Rendered {
  return renderFoxhoundAlertEmail({
    subject: message.subject,
    to,
    alert: message.alert,
    footer: [
      recoveryFooterNote(OPS_SENDER_NAME, now.getUTCFullYear()),
      manageEmailSettingsLine(baseUrl),
    ],
  });
}

/** The dead-letter alert's subject and body, Foxhound's own. Pure. */
export function deadLetterAlertMessage(
  counts: { written: number; failed: number },
  now: Date,
): { subject: string; bodyHtml: string } {
  return {
    subject: "Foxhound dunning emails DEAD-LETTERED",
    bodyHtml: [
      `<p>${counts.written} dunning email(s) exhausted their queue retries and were dead-lettered at ${now.toISOString()}.</p>`,
      counts.failed ? `<p>${counts.failed} dead letter(s) could not even be recorded.</p>` : "",
      `<p>Query email_dead_letters for the rows. One alert per day.</p>`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** Send one alert, deduped, never throwing. A cron alert (E26, E27) goes on
 *  Capsomer's alert template with Recova's footer; the dead-letter alert,
 *  Foxhound's own, keeps its HTML body. */
async function sendAlert(
  env: Env,
  cronName: string,
  kind: AlertKind,
  message: { subject: string; bodyHtml: string } | CronAlertMessage,
  now: Date,
): Promise<AlertOutcome> {
  return alertOnce({
    db: env.DB,
    key: cronName,
    kind,
    detail: message.subject,
    now,
    send: () => deliver(env, message, now),
  });
}

/** One alert mail out: true when it went, else the reason. Throws are alertOnce's to catch. */
async function deliver(
  env: Env,
  message: { subject: string; bodyHtml: string } | CronAlertMessage,
  now: Date,
): Promise<{ sent: boolean; error?: string }> {
  if ("alert" in message) {
    const rendered = renderCronAlertEmail(SUPPORT_EMAIL, message, appOrigin(env), now);
    const outcome = await sendRenderedTransactionalEmail(env, { to: SUPPORT_EMAIL, rendered });
    return outcome.status === "sent"
      ? { sent: true }
      : { sent: false, error: outcome.error ?? outcome.reason };
  }
  await sendTransactionalEmail(env, {
    to: SUPPORT_EMAIL,
    subject: message.subject,
    bodyHtml: message.bodyHtml,
  });
  return { sent: true };
}

/** The last successful run of a cron, for the failure email's context: cron_runs keeps it however long ago it was. */
async function lastSuccessAt(db: Db, cronName: string): Promise<Date | null> {
  const [row] = await db
    .select({ okAt: cronRuns.lastOkAt })
    .from(cronRuns)
    .where(eq(cronRuns.name, cronName))
    .limit(1);
  return row?.okAt == null ? null : new Date(row.okAt);
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
  counts: { written: number; failed: number },
  now: Date,
): Promise<AlertOutcome> {
  if (counts.written === 0 && counts.failed === 0) return { sent: false, reason: "deduped" };
  try {
    return await sendAlert(
      env,
      DEAD_LETTER_ALERT_KEY,
      "dead_letter",
      deadLetterAlertMessage(counts, now),
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

/** The last failed (or refused) run of a cron, for a failure the health check finds. */
async function lastFailedRun(
  db: Db,
  cronName: string,
): Promise<{ id: string; message: string | null } | null> {
  const [run] = await db
    .select({ startedAt: cronRunLog.startedAt, reason: cronRunLog.reason })
    .from(cronRunLog)
    .where(and(eq(cronRunLog.name, cronName), ne(cronRunLog.outcome, "ok")))
    .orderBy(desc(cronRunLog.id))
    .limit(1);
  return run ? { id: cronRunId(cronName, run.startedAt), message: run.reason || null } : null;
}

/** The failing, overdue and never-run detector, as a cron handler: site-runtime's
 *  cronAlert over `cron_runs`, one Foxhound mail per job and kind per day.
 *
 *  TAKES ITS JOBS AS A PARAMETER rather than importing the registry, which would
 *  be circular: the registry imports this module to register the check. The
 *  caller passes CRON_JOBS, so the expectations are still DERIVED from the
 *  registry and never from a hand list, which is what 313 required.
 *
 *  A job is stale past two of its periods (`graceMinutes` is one more period):
 *  a single skipped tick is normal (a lock held, a not-due skip) and alerting on
 *  it would train the reader to ignore the alert. A job whose last run failed is
 *  mailed as a failure, so one that failed and then stopped running is still
 *  heard about every day.
 *
 *  It reports rather than throws: a health check that fails the run it is
 *  reporting on would be its own worst finding. */
export async function runCronHealthCheck(
  env: Env,
  db: Db,
  jobs: JobSchedule[],
  now: Date,
): Promise<{ rowsProcessed: number; message: string }> {
  const scheduleOf = new Map(jobs.map((j) => [j.name, j.schedule]));
  const { found, alerted, deduped } = await cronAlert({
    db: env.DB,
    jobs: jobs.map((j) => ({
      name: j.name,
      everyMinutes: SCHEDULE_PERIOD_MS[j.schedule]! / 60_000,
    })),
    graceMinutes: (every) => every,
    each: true,
    now,
    send: async ([item]) => {
      const lastRunAt = item.lastOkAt === null ? null : new Date(item.lastOkAt);
      if (item.kind === "stale") {
        const schedule = scheduleOf.get(item.name) ?? "";
        return deliver(
          env,
          buildStaleAlertEmail({ cronName: item.name, lastRunAt, schedule }, now),
          now,
        );
      }
      const failed = await lastFailedRun(db, item.name);
      return deliver(
        env,
        buildFailureAlertEmail(
          {
            cronName: item.name,
            runId: failed?.id ?? null,
            error: failed?.message ?? null,
            lastSuccessAt: lastRunAt,
          },
          now,
        ),
        now,
      );
    },
  });
  const names = found.map((f) => `${f.name}(${f.reason})`).join(", ");
  return {
    rowsProcessed: found.length,
    message: found.length
      ? `${found.length} not well: ${names}; ${alerted.length} alerted, ${deduped.length} deduped`
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
    return await sendAlert(env, input.cronName, "failure", message, now);
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
