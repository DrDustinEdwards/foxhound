import { and, desc, eq, isNull, lt } from "drizzle-orm";
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
import { decryptToken } from "~/lib/stripe/encryption";
import {
  compareTotals,
  MONTHLY_AUDIT_FROM_NAME,
  MONTHLY_AUDIT_TEMPLATE,
  buildMonthlyAuditEmail,
} from "./monthly-email";

// THE MERGED MONTHLY AUDIT (362 ruling 3, phase (g)). One cron, one email.
//
// WHAT THIS REPLACES, AND WHY THE MERGE WAS A RULING RATHER THAN A CLEANUP.
// Session 67's walk found two monthly emails on a collision course: legacy's
// `run-scheduled-audits` (blob `be1ed2ca`, 17,054 bytes) runs the audit and
// mails the result, and Foxhound's own `audit-digest` (316) mails
// `computeFoxhoundAddsCents`. Both are monthly, both gate on `audit_auto_run`,
// both send to `notification_email`. Shipping the port naively would have given
// one merchant two emails off one toggle. 362 ruling 3: ONE email, legacy's
// treatment, absorbing the digest's number as a line item, and 315's separate
// send is superseded.
//
// SO THE DIGEST'S SEND DIES AND ITS MACHINERY LIVES. `buildDigestEmail`,
// `runAuditDigest` and `describeDigestRun` are gone. The month claim, the
// per-currency comparison, the shared opt-in predicate and the failure posture
// were all correct and are here unchanged. That split is deliberate: what died
// is the second SEND, which is what 362 ruled on, and nothing else.
//
// THE MONTH CLAIM IS `audit_digest_runs`, AND ITS NAME NOW OUTLIVES ITS SUBJECT.
// It carries `audit_digest_runs_account_period_uq (account_id, period_month)`,
// which is exactly the claim this job needs, and reusing it is what keeps this
// phase migration-free. Renaming the table to match the merged email is a
// migration and is recorded as seat debt rather than smuggled in here.
//
// LEGACY'S ALERTS RE-EVALUATION IS DELIBERATELY NOT PORTED, and this is the
// walk's verdict rather than an omission. Legacy calls
// `evaluateAlerts(supabase, accountId)` after each insert because two of ITS
// alert metrics, `audit_leaking_cents` and `audit_leaking_delta_cents`, source
// from the latest two audit runs (its own comment says so). Foxhound's
// `evaluateAlerts` is a different function: PURE, taking precomputed metrics,
// over `ALERT_METRICS`'s four (health_score_avg, mrr_at_risk_cents,
// mrr_churn_cents, mrr_contraction_cents), none of which reads `audit_runs`.
// It already runs nightly from `intelligence-ai`. Calling it here would re-run
// that evaluator over a metric set no new audit row can change. A plant pins the
// absence with this reason, so the next reader does not restore it as a gap.

/** The month a run fires in covers the month that just ended. The cron fires on
 *  the 1st, so on 2026-09-01 the run is September's send about August.
 *  Date.UTC normalizes month -1 across a year boundary. */
export function auditPeriod(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface MonthlyAuditAccountRow {
  id: string;
  auditAutoRun: boolean | null;
  auditLookbackDays: number | null;
  notificationEmail: string | null;
}

/**
 * The processing-eligible accounts, with the columns the opt-in decision needs.
 *
 * NOTE WHAT IS NOT IN THE WHERE CLAUSE: the toggle. 316's design note, kept
 * verbatim in force: the account rows are selected on the PROCESSING gate only
 * and `isDigestEnabled` decides the opt-in in TypeScript. A SQL-side
 * `eq(auditAutoRun, true)`, which is what legacy writes, would silently
 * re-derive what NULL means and could drift from the page with no test noticing.
 * The two produce the same set today, and only one of them stays correct by
 * construction.
 *
 * `accountProcessingEligibleCondition()` is where the DEMO refusal lives
 * (`id NOT LIKE 'demo\\_%'`), alongside processing-paused and cancelled. Reused
 * unchanged; this phase does not touch the firewall.
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

export interface MonthlyAuditConnection {
  stripeUserId: string;
  encryptedAccessToken: string;
}

/**
 * The live primary connection for one account, or null.
 *
 * TWO OF LEGACY'S THREE FILTERS, and the third is deliberately absent.
 * `is_primary = true` and `disconnected_at IS NULL` are ported. Legacy's
 * `stripe_user_id NOT LIKE 'acct_demo%'` is NOT, because it is legacy's ONLY
 * demo firewall and Foxhound's sits one level up: the demo account's id carries
 * `DEMO_ACCOUNT_ID_PREFIX`, so `accountProcessingEligibleCondition()` has
 * already refused it before this function is reached. Adding a second
 * prefix check here would mint a demo constant nothing else uses and would put
 * the firewall in two places, which is how the two drift. This phase's bounds
 * forbid touching the firewall, and this is what not touching it looks like.
 */
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
    .where(
      and(
        eq(stripeConnections.accountId, accountId),
        eq(stripeConnections.isPrimary, true),
        isNull(stripeConnections.disconnectedAt),
      ),
    )
    .limit(1);

  if (!row?.encryptedAccessToken) return null;
  return { stripeUserId: row.stripeUserId, encryptedAccessToken: row.encryptedAccessToken };
}

/** The prior month's cumulative snapshot for this account, or null when this is
 *  the first one. Ordered by the period string, which sorts correctly because it
 *  is zero-padded YYYY-MM. */
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
        and(
          eq(auditDigestRuns.accountId, accountId),
          lt(auditDigestRuns.periodMonth, periodMonth),
        ),
      )
      .orderBy(desc(auditDigestRuns.periodMonth))
      .limit(1)
  )[0];
  return row?.totals ?? null;
}

/** The claim: the row this caller now holds, or the status of the row that
 *  refused it. */
export type MonthClaim = { claimed: true; id: string } | { claimed: false; heldStatus: string };

/**
 * Claim this account's slot for this month. A claimed result means this caller
 * may run and send.
 *
 * THE REFUSAL IS THE DATABASE'S. The unique index on
 * (account_id, period_month) rejects the second insert, so two deliveries of one
 * queue message cannot both mail one merchant, and a second cron tick inside the
 * same month does nothing. Application-side "select then insert" could
 * interleave between the two statements; an index cannot.
 *
 * A FAILED CLAIM IS RETAKEN, AND ONLY A FAILED ONE (job_97878f0d1fde). The audit
 * now runs from a queue message and a failure asks the queue to retry, so the
 * retry has to be able to run. The retake is one conditional UPDATE from
 * "failed" to "pending": two deliveries racing for it cannot both win, because
 * only one of them finds the row still failed. A row that is "pending" is a run
 * in flight (or one that died mid-run) and is never retaken, so a crash costs
 * that merchant one month's email rather than risking a second one; every other
 * status is a finished month.
 *
 * AN INSERT ERROR IS A REFUSAL ONLY WHEN A ROW STANDS BEHIND IT (PR 143 review).
 * The insert can fail for a transient D1 reason as well as for the index. When
 * there is nothing to retake and no row exists, the insert's own error is
 * rethrown, so the message retries instead of being acked as a duplicate.
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

/** The registered cron's name (app/lib/cron/registry.ts), which the consumer's
 *  last-attempt alert is filed under. */
const MONTHLY_AUDIT_CRON_NAME = "monthly-audit";

/** One queue message: one account, one month, and the cron run that queued it. */
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
 * WHY A QUEUE (job_97878f0d1fde). Since PR 123 the audit's Stripe reads page to
 * the end (RULES.md 3.19), so one account costs a fixed handful of subrequests
 * plus one per page of its own data, with no upper bound. Auditing every account
 * in this one invocation put all of them under one subrequest limit, and one
 * large account could starve every account after it. Each message is consumed
 * in its own invocation (max_batch_size 1), so each account gets its own budget.
 *
 * This invocation makes 1 D1 read plus ceil(opted-in / 100) sendBatch calls,
 * besides runCronJob's own bookkeeping, and touches no Stripe account.
 *
 * A sendBatch that throws fails the cron run, so runCronJob records it and the
 * failure alert fires. Messages already sent stay sent, and a re-run is safe:
 * the month claim refuses any account that already finished.
 */
export async function enqueueMonthlyAudits(
  env: Env,
  now: Date,
  cronRunId: string | null,
): Promise<MonthlyAuditEnqueueResult> {
  const db = getDb(env);
  const periodMonth = auditPeriod(now);
  const candidates = await monthlyAuditCandidates(db);
  // THE SHARED PREDICATE. NULL and false are both off, exactly as the page
  // renders them, and exactly as legacy's `= true` resolves them.
  const optedIn = candidates.filter((account) => isDigestEnabled(account.auditAutoRun));

  for (let i = 0; i < optedIn.length; i += AUDIT_QUEUE_SEND_BATCH_MAX) {
    const chunk = optedIn.slice(i, i + AUDIT_QUEUE_SEND_BATCH_MAX);
    await env.AUDIT_QUEUE.sendBatch(
      chunk.map((account) => ({
        body: { accountId: account.id, periodMonth, cronRunId } satisfies MonthlyAuditMessage,
      })),
    );
  }

  return { eligible: candidates.length, optedIn: optedIn.length, enqueued: optedIn.length };
}

/** The opted-in, processing-eligible account row, or null. Read again at
 *  delivery: a merchant who switched the audit off, paused processing or
 *  cancelled after the cron queued them is not audited, and the demo firewall
 *  (`accountProcessingEligibleCondition`) sits on this path too. */
async function eligibleAccount(
  db: Db,
  accountId: string,
): Promise<MonthlyAuditAccountRow | null> {
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

export type MonthlyAuditAccountStatus =
  | "sent"
  | "duplicate"
  | "not_eligible"
  | "no_connection"
  | "no_recipient"
  /** The address is on the suppression list; nothing was sent (E24). */
  | "suppressed"
  /** The live-send gate held the mail. Unreachable while this sender passes
   *  liveSendGate "skip"; kept so the mapping stays total (E24). */
  | "blocked"
  /** The email_sends claim for this month already stood (E24). */
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
 * merchant notice path (E24).
 *
 * THE MERCHANT NOTICE PATH, NOT THE AUTH SENDER (E24). Recova sends this from
 * FROM_HELLO, and the auth sender's domain is kept for sign-in mail
 * (constants.ts, EMAIL_AUTH_DOMAIN; RULES.md 4.13). So it goes through
 * processEmailJob on the merchant audience, as E10 and E21 do: From "Foxhound"
 * at Foxhound's merchant-facing address, Recova's footer sentence and its
 * "Manage email settings" link, no unsubscribe, no Reply-To, the email_sends
 * claim and suppression. It is NOT held by the per-account live-send switch
 * (liveSendGate "skip"), which Recova does not have and which is off for every
 * real merchant (review round 1 of PR 160). Each of its outcomes settles the
 * month under its own name; only a provider failure is retried.
 *
 * NO OUTCOME AND NO BILLING ROW. `saveAuditRun` is a plain insert, not a money
 * write, because the audit is free under PRICING rev 3 and recording one creates
 * no attributed recovery and gates no fee. Pinned by plant in three modules.
 *
 * ONCE THE EMAIL HAS LEFT, NOTHING AFTER IT CAN TURN THE MONTH INTO A RETRY. A
 * failure after the send is logged and the outcome stays "sent", because a
 * retried message would mail the merchant a second time.
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
      // Legacy `continue`s past an account with no primary connection. The
      // claim is settled rather than left pending, so the row says why.
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

    // Phase (d), unchanged. The run is history whether or not the email sends.
    const runId = await saveAuditRun(env, audit, {
      accountId,
      isAuthenticated: true,
      summary: summary.summary,
      now,
    });

    const totals = await computeFoxhoundAddsCents(db, accountId);

    if (!account.notificationEmail) {
      // Legacy sends only when notification_email is set, and 339 makes it the
      // only recipient. The audit still ran and is still readable in history.
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
      baseUrl: env.BETTER_AUTH_URL ?? "",
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
        // Not held by the live-send switch, which Recova does not have and which
        // is off for every real merchant (RULES.md 3.21). Demo and ineligible
        // accounts were already refused by eligibleAccount above.
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
      console.error(`monthly audit: account ${accountId} (${periodMonth}) mailed, then failed:`, err);
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
 * FAILURE POSTURE (job_97878f0d1fde). The whole err is logged and the message is
 * retried; one account's failure never touches another's message. The delivery
 * whose attempts exceed AUDIT_QUEUE_MAX_RETRIES is the last one Cloudflare will
 * make, so that one also raises the monthly-audit failure alert, the same
 * machinery a failed cron run uses (313). A body this producer did not write is
 * acked, because retrying it cannot make it parse.
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
      // The account is named in the alert itself (PR 143 review): alerts are
      // deduped per cron per day, so the one email that goes out has to say
      // which merchant it is about.
      { cronName: MONTHLY_AUDIT_CRON_NAME, runId: message.cronRunId, error: `${where}: ${error}` },
      now,
    );

  if (outcome.status === "duplicate") {
    // A first delivery refused by its claim is the ordinary case (a second cron
    // tick, an at-least-once duplicate) and stays quiet. A REDELIVERY refused is
    // worth a line: the earlier attempt either finished or died mid-run.
    if (attempts > 1) {
      console.error(
        `monthly audit: ${where} claim refused on attempt ${attempts}, row is ${outcome.heldStatus}`,
      );
    }
    // STUCK PENDING (PR 143 review). A run killed mid-flight leaves its claim
    // pending, and pending is never retaken, so nothing is sent twice. The
    // message is retried so a run still in flight can finish, and the last
    // attempt alerts, so a stuck month is seen rather than discovered.
    if (attempts > 1 && outcome.heldStatus === "pending") {
      if (!lastAttempt) return "retry";
      // "May not", never "was not": the run may have died after the send and
      // before the row was marked sent (job_17249e7da871).
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

/** How the cron run reads in cron_run_history and on /admin/operations. Each
 *  account's own result is its audit_digest_runs row. */
export function describeMonthlyAuditRun(result: MonthlyAuditEnqueueResult): string {
  return (
    `${result.eligible} eligible, ${result.optedIn} opted in, ` +
    `${result.enqueued} queued for audit`
  );
}
