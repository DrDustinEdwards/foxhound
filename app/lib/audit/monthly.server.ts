import { chunked } from "@dustinedwards/site-runtime/d1";
import { appOrigin } from "~/lib/app-origin";
import { and, desc, eq, lt } from "drizzle-orm";
import { type Db, accounts, auditDigestRuns, getDb, stripeConnections } from "~/db";
import { computeFoxhoundAddsCents, type CurrencyCents } from "~/lib/audit/full-audit.server";
import { saveAuditRun } from "~/lib/audit/persist.server";
import { runFullAudit } from "~/lib/audit/run.server";
import { AUDIT_QUEUE_MAX_RETRIES, AUDIT_QUEUE_SEND_BATCH_MAX } from "~/lib/constants";
import { alertCronFailure } from "~/lib/cron/alerts.server";
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";
import { processEmailJob } from "~/lib/email/dispatch";
import { recoveryFooterNote } from "~/lib/email/templates";
import { isDigestEnabled, readAuditSettings } from "~/lib/settings/audit-settings";
import { activePrimaryConnectionWhere } from "~/lib/stripe/connections.server";
import { decryptToken } from "~/lib/stripe/encryption";
import {
  compareTotals,
  MONTHLY_AUDIT_FROM_NAME,
  MONTHLY_AUDIT_TEMPLATE,
  buildMonthlyAuditEmail,
} from "./monthly-email";
import { monthKey } from "@dustinedwards/site-runtime/time";

// THE MERGED MONTHLY AUDIT. One cron, one email.
//
// It carries `audit_digest_runs_account_period_uq (account_id, period_month)`,
// which is exactly the claim this job needs, and reusing it is what keeps this
// phase migration-free.

/**
 * The month a run fires in covers the month that just ended. The cron fires on
 * the 1st, so on 2026-09-01 the run is September's send about August. Date.UTC
 * normalizes month -1 across a year boundary.
 */
function auditPeriod(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return monthKey(d);
}

interface MonthlyAuditAccountRow {
  id: string;
  auditAutoRun: boolean | null;
  auditLookbackDays: number | null;
  notificationEmail: string | null;
}

/**
 * The processing-eligible accounts, with the columns the opt-in decision needs.
 */
async function monthlyAuditCandidates(db: Db): Promise<MonthlyAuditAccountRow[]> {
  return db
    .select({
      id: accounts.id,
      auditAutoRun: accounts.auditAutoRun,
      auditLookbackDays: accounts.auditLookbackDays,
      notificationEmail: accounts.notificationEmail,
    })
    .from(accounts)
    .where(accountProcessingEligibleCondition());
}

interface MonthlyAuditConnection {
  stripeUserId: string;
  encryptedAccessToken: string;
}

/** The live primary connection for one account, or null. */
async function primaryConnection(
  db: Db,
  accountId: string,
): Promise<MonthlyAuditConnection | null> {
  const [row] = await db
    .select({
      stripeUserId: stripeConnections.stripeUserId,
      encryptedAccessToken: stripeConnections.stripeAccessToken,
    })
    .from(stripeConnections)
    .where(activePrimaryConnectionWhere(accountId))
    .limit(1);

  if (!row?.encryptedAccessToken) return null;
  return { stripeUserId: row.stripeUserId, encryptedAccessToken: row.encryptedAccessToken };
}

/**
 * The prior month's cumulative snapshot for this account, or null when this is
 * the first one. Ordered by the period string, which sorts correctly because it
 * is zero-padded YYYY-MM.
 */
async function priorTotals(
  db: Db,
  accountId: string,
  periodMonth: string,
): Promise<CurrencyCents[] | null> {
  const row = (
    await db
      .select({ totals: auditDigestRuns.totals })
      .from(auditDigestRuns)
      .where(
        and(eq(auditDigestRuns.accountId, accountId), lt(auditDigestRuns.periodMonth, periodMonth)),
      )
      .orderBy(desc(auditDigestRuns.periodMonth))
      .limit(1)
  )[0];
  return row?.totals ?? null;
}

/**
 * The claim: the row this caller now holds, or the status of the row that
 * refused it.
 */
type MonthClaim = { claimed: true; id: string } | { claimed: false; heldStatus: string };

/**
 * Claim this account's slot for this month. A claimed result means this caller
 * may run and send.
 *
 * The unique index on (account_id, period_month) rejects the second insert, so
 * two deliveries of one queue message cannot both mail one merchant, and a
 * second cron tick inside the same month does nothing. Application-side "select
 * then insert" could interleave between the two statements; an index cannot.
 */
async function claimMonthSlot(
  db: Db,
  accountId: string,
  periodMonth: string,
  now: Date,
  cronRunId: string | null,
): Promise<MonthClaim> {
  const id = crypto.randomUUID();
  try {
    await db.insert(auditDigestRuns).values({
      id,
      accountId,
      periodMonth,
      totals: null,
      status: "pending",
      error: null,
      sentAt: null,
      cronRunId,
      createdAt: now,
    });
    return { claimed: true, id };
  } catch (insertError) {
    const slot = and(
      eq(auditDigestRuns.accountId, accountId),
      eq(auditDigestRuns.periodMonth, periodMonth),
    );
    const [retaken] = await db
      .update(auditDigestRuns)
      .set({ status: "pending", error: null })
      .where(and(slot, eq(auditDigestRuns.status, "failed")))
      .returning({ id: auditDigestRuns.id });
    if (retaken) return { claimed: true, id: retaken.id };

    const [held] = await db
      .select({ status: auditDigestRuns.status })
      .from(auditDigestRuns)
      .where(slot)
      .limit(1);
    if (!held) throw insertError;
    return { claimed: false, heldStatus: held.status };
  }
}

/**
 * The registered cron's name (app/lib/cron/registry.ts), which the consumer's
 * last-attempt alert is filed under.
 */
const MONTHLY_AUDIT_CRON_NAME = "monthly-audit";

/**
 * One queue message: one account, one month, and the cron run that queued it.
 */
export interface MonthlyAuditMessage {
  accountId: string;
  periodMonth: string;
  cronRunId: string | null;
}

/** The message body, or null when it is not one this producer wrote. */
export function parseMonthlyAuditMessage(body: unknown): MonthlyAuditMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const { accountId, periodMonth, cronRunId } = body as Record<string, unknown>;
  if (typeof accountId !== "string" || accountId === "") return null;
  if (typeof periodMonth !== "string" || !/^\d{4}-\d{2}$/.test(periodMonth)) return null;
  if (cronRunId !== null && typeof cronRunId !== "string") return null;
  return { accountId, periodMonth, cronRunId };
}

export interface MonthlyAuditEnqueueResult {
  eligible: number;
  optedIn: number;
  enqueued: number;
}

/**
 * The cron half: one queue message per opted-in, processing-eligible account.
 *
 * This invocation makes 1 D1 read plus ceil(opted-in / 100) sendBatch calls,
 * besides runScheduledJobs' own bookkeeping, and touches no Stripe account.
 */
export async function enqueueMonthlyAudits(
  env: Env,
  now: Date,
  cronRunId: string | null,
): Promise<MonthlyAuditEnqueueResult> {
  const db = getDb(env);
  const periodMonth = auditPeriod(now);
  const candidates = await monthlyAuditCandidates(db);
  // THE SHARED PREDICATE.
  const optedIn = candidates.filter((account) => isDigestEnabled(account.auditAutoRun));

  for (const chunk of chunked(optedIn, AUDIT_QUEUE_SEND_BATCH_MAX)) {
    await env.AUDIT_QUEUE.sendBatch(
      chunk.map((account) => ({
        body: { accountId: account.id, periodMonth, cronRunId } satisfies MonthlyAuditMessage,
      })),
    );
  }

  return { eligible: candidates.length, optedIn: optedIn.length, enqueued: optedIn.length };
}

/**
 * The opted-in, processing-eligible account row, or null. Read again at
 * delivery: a merchant who switched the audit off, paused processing or
 * canceled after the cron queued them is not audited, and the demo firewall
 * (`accountProcessingEligibleCondition`) sits on this path too.
 */
async function eligibleAccount(db: Db, accountId: string): Promise<MonthlyAuditAccountRow | null> {
  const [row] = await db
    .select({
      id: accounts.id,
      auditAutoRun: accounts.auditAutoRun,
      auditLookbackDays: accounts.auditLookbackDays,
      notificationEmail: accounts.notificationEmail,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), accountProcessingEligibleCondition()))
    .limit(1);
  if (!row || !isDigestEnabled(row.auditAutoRun)) return null;
  return row;
}

type MonthlyAuditAccountStatus =
  | "sent"
  | "duplicate"
  | "not_eligible"
  | "no_connection"
  | "no_recipient"
  /** The address is on the suppression list; nothing was sent. */
  | "suppressed"
  /**
   * The live-send gate held the mail. Unreachable while this sender passes
   * liveSendGate "skip"; kept so the mapping stays total.
   */
  | "blocked"
  /** The email_sends claim for this month already stood. */
  | "already_sent"
  | "failed";

export interface MonthlyAuditAccountOutcome {
  status: MonthlyAuditAccountStatus;
  /** Whether the Stripe reads ran on this delivery. */
  ran: boolean;
  /** The thrown value, whole, on a failed outcome. */
  error?: unknown;
  /** On a duplicate: the status of the claim row that refused this delivery. */
  heldStatus?: string;
}

/**
 * The consumer half: one account, one month. Claimed by the database, audited
 * against live Stripe, persisted through phase (d), and mailed once on the
 * merchant notice path.
 */
export async function auditAccountForMonth(
  env: Env,
  message: MonthlyAuditMessage,
  now: Date,
): Promise<MonthlyAuditAccountOutcome> {
  const db = getDb(env);
  const { accountId, periodMonth, cronRunId } = message;

  const account = await eligibleAccount(db, accountId);
  if (!account) return { status: "not_eligible", ran: false };

  const claim = await claimMonthSlot(db, accountId, periodMonth, now, cronRunId);
  if (!claim.claimed) return { status: "duplicate", ran: false, heldStatus: claim.heldStatus };
  const claimId = claim.id;

  let ran = false;
  let mailed = false;
  try {
    const connection = await primaryConnection(db, accountId);
    if (!connection) {
      await db
        .update(auditDigestRuns)
        .set({ status: "no_connection" })
        .where(eq(auditDigestRuns.id, claimId));
      return { status: "no_connection", ran };
    }

    const { lookbackDays } = readAuditSettings({
      auditLookbackDays: account.auditLookbackDays,
      auditAutoRun: account.auditAutoRun,
    });

    const accessToken = await decryptToken(env, connection.encryptedAccessToken);
    const { result: audit, summary } = await runFullAudit(
      env,
      accessToken,
      connection.stripeUserId,
      lookbackDays,
      now,
    );
    ran = true;

    // The run is history whether or not the email sends.
    const runId = await saveAuditRun(env, audit, {
      accountId,
      isAuthenticated: true,
      summary: summary.summary,
      now,
    });

    const totals = await computeFoxhoundAddsCents(db, accountId);

    if (!account.notificationEmail) {
      await db
        .update(auditDigestRuns)
        .set({ totals, status: "no_recipient" })
        .where(eq(auditDigestRuns.id, claimId));
      return { status: "no_recipient", ran };
    }

    const comparisons = compareTotals(totals, await priorTotals(db, accountId, periodMonth));
    const email = buildMonthlyAuditEmail({
      result: audit,
      summary: summary.summary,
      runId,
      baseUrl: appOrigin(env),
      comparisons,
    });
    const sent = await processEmailJob(
      env,
      {
        accountId,
        to: account.notificationEmail,
        fromName: MONTHLY_AUDIT_FROM_NAME,
        subject: email.subject,
        blocks: email.blocks,
        footerNote: recoveryFooterNote(MONTHLY_AUDIT_FROM_NAME, now.getUTCFullYear()),
        template: MONTHLY_AUDIT_TEMPLATE,
        // Platform-to-merchant mail. See EmailAudience.
        audience: "merchant",
        liveSendGate: "skip",
        unsubscribeToken: "",
        physicalAddress: "",
        // One logical send per account per month, as the month claim is.
        idempotencyKey: `monthly-audit:${accountId}:${periodMonth}`,
        cronRunId,
      },
      null,
    );
    // A provider failure is a failure: the claim is marked failed below and the
    // queue retries, and processEmailJob lets that retry retake its own claim.
    if (sent.status === "failed" || sent.status === "pending") {
      throw new Error(sent.error ?? "monthly audit email failed");
    }
    // "duplicate" means this month's email_sends claim already stood, so the
    // mail may have left; it is never sent again.
    mailed = sent.status === "sent" || sent.status === "duplicate";
    const status: MonthlyAuditAccountStatus =
      sent.status === "sent" ? "sent" : sent.status === "duplicate" ? "already_sent" : sent.status;

    await db
      .update(auditDigestRuns)
      .set({ totals, status, sentAt: sent.status === "sent" ? now : null })
      .where(eq(auditDigestRuns.id, claimId));
    return { status, ran };
  } catch (err) {
    if (mailed) {
      // The merchant has the email. The claim row may still read "pending",
      // which every later delivery treats as taken, so nothing is sent twice.
      console.error(
        `monthly audit: account ${accountId} (${periodMonth}) mailed, then failed:`,
        err,
      );
      return { status: "sent", ran };
    }
    const error = err instanceof Error ? err.message : "monthly audit failed";
    await db
      .update(auditDigestRuns)
      .set({ status: "failed", error })
      .where(eq(auditDigestRuns.id, claimId))
      .catch(() => {
        // Best effort. The retry the caller asks for is what surfaces it.
      });
    return { status: "failed", ran, error: err };
  }
}

/**
 * One delivered message, start to finish, and what the queue should do with it.
 *
 * The whole err is logged and the message is retried; one account's failure
 * never touches another's message. A body this producer did not write is acked,
 * because retrying it cannot make it parse.
 */
export async function processMonthlyAuditMessage(
  env: Env,
  body: unknown,
  attempts: number,
  now: Date,
): Promise<"ack" | "retry"> {
  const message = parseMonthlyAuditMessage(body);
  if (!message) {
    console.error("monthly audit: dropped a malformed queue message:", body);
    return "ack";
  }

  let outcome: MonthlyAuditAccountOutcome;
  try {
    outcome = await auditAccountForMonth(env, message, now);
  } catch (err) {
    // Before the claim existed (the account read or the claim itself threw), so
    // there is no row to mark. The retry is the record.
    outcome = { status: "failed", ran: false, error: err };
  }
  const where = `account ${message.accountId} (${message.periodMonth})`;
  const lastAttempt = attempts > AUDIT_QUEUE_MAX_RETRIES;
  const alert = (error: string) =>
    alertCronFailure(
      env,
      getDb(env),
      // The account is named in the alert itself: alerts are deduped per cron
      // per day, so the one email that goes out has to say which merchant it is
      // about.
      { cronName: MONTHLY_AUDIT_CRON_NAME, runId: message.cronRunId, error: `${where}: ${error}` },
      now,
    );

  if (outcome.status === "duplicate") {
    // A first delivery refused by its claim is the ordinary case (a second cron
    // tick, an at-least-once duplicate) and stays quiet.
    if (attempts > 1) {
      console.error(
        `monthly audit: ${where} claim refused on attempt ${attempts}, row is ${outcome.heldStatus}`,
      );
    }
    // STUCK PENDING. A run killed mid-flight leaves its claim pending, and
    // pending is never retaken, so nothing is sent twice. The message is
    // retried so a run still in flight can finish, and the last attempt alerts,
    // so a stuck month is seen rather than discovered.
    if (attempts > 1 && outcome.heldStatus === "pending") {
      if (!lastAttempt) return "retry";
      // "May not", never "was not": the run may have died after the send and
      // before the row was marked sent.
      await alert(
        "claim still pending after the last attempt; this month's email may not have been sent",
      );
    }
    return "ack";
  }
  if (outcome.status !== "failed") return "ack";

  console.error(`monthly audit: ${where} failed on attempt ${attempts}:`, outcome.error);
  if (lastAttempt) {
    await alert(outcome.error instanceof Error ? outcome.error.message : "monthly audit failed");
  }
  return "retry";
}

/**
 * How the cron run reads in cron_run_log and on /admin/operations. Each
 * account's own result is its audit_digest_runs row.
 */
export function describeMonthlyAuditRun(result: MonthlyAuditEnqueueResult): string {
  return (
    `${result.eligible} eligible, ${result.optedIn} opted in, ` +
    `${result.enqueued} queued for audit`
  );
}
