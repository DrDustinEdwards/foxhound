import { appOrigin } from "~/lib/app-origin";
import {
  alertOnce,
  cronAlert,
  describeAge,
  type AlertOutcome,
} from "@dustinedwards/site-runtime/cron-alert";
import { deployedAt } from "@dustinedwards/site-runtime/deploy";
import { and, desc, eq, ne } from "drizzle-orm";

import type { Db } from "~/db/client";
import { cronRunLog, cronRuns } from "~/db/schema";
import { cronRunId, describeCronSchedule } from "~/lib/admin/crons";
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

/**
 * Cron-failure alerting. A failing cron records a
 * failed run and notifies NOBODY, so a job that fails every run fails silently
 * until somebody opens /admin/operations.
 *
 * FAIL-OPEN, ALWAYS: the alerting path must never take down the cron it
 * observes. Every send is caught, its outcome returned for the caller to
 * record, and never rethrown.
 */

type AlertKind = "failure" | "stale" | "dead_letter";
export type { AlertOutcome };

/**
 * How long each schedule may go without a run before it is STALE.
 *
 * The JOBS come from the registry, never a hand list, which is what 313
 * required.
 */
export const SCHEDULE_PERIOD_MS: Record<string, number> = {
  [CRON_SCHEDULE_RECOVERY_TICK]: 5 * 60 * 1000,
  [CRON_SCHEDULE_WEEKLY]: 7 * DAY_MS,
  [CRON_SCHEDULE_DAILY]: DAY_MS,
  [CRON_SCHEDULE_MONTHLY]: 31 * DAY_MS,
  // The merged monthly audit's own hour, at the other monthly jobs' period.
  [CRON_SCHEDULE_MONTHLY_AUDIT]: 31 * DAY_MS,
  [CRON_SCHEDULE_EXPIRING_CARDS]: DAY_MS,
  // Every minute, judged at five: the daily check runs on its own trigger, and
  // a tick skipped on the lock is normal, so a one-minute period would alert on
  // a healthy job.
  [CRON_SCHEDULE_BLOG]: 5 * 60 * 1000,
};

export interface JobSchedule {
  name: string;
  schedule: string;
}

/** A job the health check found not well, for the stale mail. */
export interface StaleFinding {
  cronName: string;
  /**
   * The last success (cron_runs.last_ok_at); null when it never succeeded,
   * which is the billing-monthly case.
   */
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

const OPS_TAG = "[Foxhound Ops]";
const OPS_SENDER_NAME = "Foxhound Ops";
const STACK_EXCERPT_CHARS = 500;

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

export function buildStaleAlertEmail(
  finding: StaleFinding & { schedule: string },
  now: Date,
): CronAlertMessage {
  const agePhrase = finding.lastRunAt
    ? `last succeeded ${describeAge(now.getTime() - finding.lastRunAt.getTime())}`
    : "never succeeded";
  const cadence = describeCronSchedule(finding.schedule);
  const cadenceSuffix = cadence ? `, schedule: ${cadence}` : "";
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

export function billingFailureError(failedAccountIds: string[], periodStart: Date): string | null {
  if (failedAccountIds.length === 0) return null;
  const monthLabel = periodStart.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${failedAccountIds.length} account(s) failed to invoice for ${monthLabel}: ${failedAccountIds.join(", ")}.`;
}

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

/** Send one alert, deduped, never throwing. */
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

/**
 * One alert mail out: true when it went, else the reason. Throws are
 * alertOnce's to catch.
 */
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

/**
 * The last successful run of a cron, for the failure email's context: cron_runs
 * keeps it however long ago it was.
 */
async function lastSuccessAt(db: Db, cronName: string): Promise<Date | null> {
  const [row] = await db
    .select({ okAt: cronRuns.lastOkAt })
    .from(cronRuns)
    .where(eq(cronRuns.name, cronName))
    .limit(1);
  return row?.okAt == null ? null : new Date(row.okAt);
}

/**
 * The dead-letter alert (313 build B). Shares the dedupe mechanism with the
 * cron alerts, keyed on the pseudo-cron name below, so a burst of dead letters
 * raises ONE email per day rather than one per message.
 */
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

/**
 * The last failed (or refused) run of a cron, for a failure the health check
 * finds.
 */
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

/**
 * The failing, overdue and never-run detector, as a cron handler:
 * site-runtime's cronAlert over `cron_runs`, one Foxhound mail per job and kind
 * per day.
 *
 * The caller passes CRON_JOBS, so the expectations are still DERIVED from the
 * registry and never from a hand list, which is what 313 required.
 */
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
    deployedAt: deployedAt(env),
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
