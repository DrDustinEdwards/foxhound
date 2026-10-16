import { and, desc, eq, isNull, lt } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, auditDigestRuns, getDb, stripeConnections } from "~/db";
import { computeFoxhoundAddsCents, type CurrencyCents } from "~/lib/audit/full-audit.server";
import { saveAuditRun } from "~/lib/audit/persist.server";
import { formatBps, formatCents, SCOPE_UNREAD } from "~/lib/audit/render";
import { formatMoney } from "~/lib/money-format";
import { runFullAudit } from "~/lib/audit/run.server";
import {
  AUDIT_QUEUE_MAX_RETRIES,
  AUDIT_QUEUE_SEND_BATCH_MAX,
} from "~/lib/constants";
import { alertCronFailure } from "~/lib/cron/alerts.server";
import { accountProcessingEligibleCondition } from "~/lib/cron/recovery-tick";
import { sendTransactionalEmail } from "~/lib/email/send";
import { isDigestEnabled, readAuditSettings } from "~/lib/settings/audit-settings";
import { decryptToken } from "~/lib/stripe/encryption";

import type { AuditResult, ScopeOutcome } from "./engine";

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

export interface CurrencyComparison {
  currency: string;
  /** The cumulative attributed-recovery total, this run. */
  cents: number;
  /** Change since the prior month's snapshot, or null when there is none. */
  changeCents: number | null;
}

/**
 * Compare this run's cumulative snapshot against the previous month's.
 *
 * PER CURRENCY, NEVER SUMMED ACROSS THEM. core.md records cross-currency
 * summing as a live data-correctness defect in Intelligence; this does not
 * repeat it. A currency present in only one of the two snapshots still produces
 * a row (missing side reads 0), so a currency that went to zero is visible as a
 * fall rather than vanishing.
 *
 * A null `prior` is a FIRST RUN and not a zero. The change is null and the email
 * says so rather than printing "+$0".
 */
export function compareTotals(
  current: CurrencyCents[],
  prior: CurrencyCents[] | null,
): CurrencyComparison[] {
  const priorByCurrency = new Map((prior ?? []).map((c) => [c.currency, c.cents]));
  const currentByCurrency = new Map(current.map((c) => [c.currency, c.cents]));
  const currencies = new Set([...currentByCurrency.keys(), ...priorByCurrency.keys()]);

  return [...currencies].sort().map((currency) => {
    const cents = currentByCurrency.get(currency) ?? 0;
    return {
      currency,
      cents,
      changeCents: prior === null ? null : cents - (priorByCurrency.get(currency) ?? 0),
    };
  });
}

/** Legacy's subject, with the one brand substitution. */
export const MONTHLY_AUDIT_SUBJECT = "Your monthly Foxhound report";

/**
 * A figure, or the one sentence every audit surface uses for a scope that could
 * not be read.
 *
 * 362 RULING 2 REACHES THE EMAIL. The engine carries a per-scope status, phase
 * (d) stored it as the NULL and phase (e) rendered it as a sentence; an email
 * that coalesced it back to a zero would tell a merchant they have no open
 * disputes on the strength of a Stripe call that failed. Legacy cannot make this
 * mistake in its email because its engine already zeroed the scope upstream,
 * which is the same lie one layer earlier.
 */
function figure<T>(scope: ScopeOutcome<T>, render: (data: T) => string): string {
  return scope.ok ? render(scope.data) : SCOPE_UNREAD;
}

function row(label: string, value: string): string {
  return `<p><strong>${label}:</strong> ${value}</p>`;
}

export interface MonthlyAuditEmailInput {
  result: AuditResult;
  /** The run's summary, model-written or the fallback. Foxhound's AuditResult
   *  carries no `aiSummary` field (legacy's does); phase (c) kept the summary a
   *  separate discriminated outcome so a caller can tell a real one from the
   *  fallback, and the email takes the string the caller resolved. */
  summary: string;
  /** The stored run this email links to. Account-scoped at the reader. */
  runId: string;
  baseUrl: string;
  comparisons: CurrencyComparison[];
  periodMonth: string;
}

/**
 * The merged email. Pure, so its content is assertable without sending
 * anything, mirroring `buildFailureAlertEmail` and the digest it replaces.
 *
 * LEGACY'S STRINGS, FOXHOUND'S TREATMENT. Every section heading and row label
 * below is legacy's verbatim (`buildAuditEmailBody`), with "Recova" becoming
 * "Foxhound" in the one heading that names the product. What is NOT ported is
 * its presentation: legacy builds inline-styled tiles out of an `EMAIL_COLORS`
 * module Foxhound does not have, and 316 already ruled plain semantic HTML for
 * this send, matching every other body this repo builds. Legacy's `&mdash;`
 * row separators are an em dash in the merchant's inbox and are not ported.
 *
 * THREE OF LEGACY'S TILES ARE ABSENT, each because its producer is. Legacy's
 * "What Recova did this month" block reads four tables through
 * `fetchActivityStats` for a recovery rate, card-alert count and win-back count.
 * 362 ruling 3 names ONE absorbed line, `computeFoxhoundAddsCents`, which is
 * Foxhound's answer to the same question and the number the superseded digest
 * carried. The rest of that block is not built rather than half-built.
 */
export function buildMonthlyAuditEmail(input: MonthlyAuditEmailInput): {
  subject: string;
  bodyHtml: string;
} {
  const { result, summary, runId, baseUrl, comparisons, periodMonth } = input;
  const cur = result.meta.currency;
  const link = `${baseUrl}/audit/results/${runId}`;

  // The absorbed digest line, with the month-over-month delta the claim table's
  // stored snapshot already makes available.
  //
  // THE ONE PLACE THIS EMAIL KEEPS ITS CENTS, and the split is deliberate.
  // Legacy formats every figure in this email at zero fraction digits, and for
  // the DIAGNOSTIC figures that is right: nobody reconciles an MRR estimate to
  // the penny and the decimals are noise. This line is not a diagnostic. It is
  // the attributed-recovery total that PRICING rev 3 charges 20% of, so a
  // merchant may well tie it to an invoice, and rounding $12.40 to $12 in a
  // number they can be billed against is the wrong kind of tidy. The digest this
  // absorbed used `formatMoney` for exactly this figure and keeps it.
  const addsLines = comparisons.length
    ? comparisons.map((c) => {
        const total = `<strong>${formatMoney(c.cents, c.currency)}</strong>`;
        if (c.changeCents === null) {
          return `<p>${total} recovered to date (${c.currency.toUpperCase()}).</p>`;
        }
        const dir = c.changeCents >= 0 ? "up" : "down";
        return `<p>${total} recovered to date (${c.currency.toUpperCase()}), ${dir} ${formatMoney(Math.abs(c.changeCents), c.currency)} since last month.</p>`;
      })
    : [`<p>No recovered payments are attributed to Foxhound yet.</p>`];

  const disputeWinRate = result.disputes.ok
    ? (() => {
        const { won, lost } = result.disputes.data.historical;
        return won + lost > 0
          ? `${Math.round((won / (won + lost)) * 100)}% (${won}W / ${lost}L)`
          : null;
      })()
    : SCOPE_UNREAD;

  const advisory = result.cardUpdater.ok ? result.cardUpdater.data.advisory : null;

  const bodyHtml = [
    summary ? `<p>${summary}</p>` : "",

    `<h2>What Foxhound did this month</h2>`,
    ...addsLines,

    `<h2>Your Stripe health</h2>`,
    row("MRR", figure(result.health, (h) => formatCents(h.mrrCents, cur))),
    row("ARR", figure(result.health, (h) => formatCents(h.arrCents, cur))),
    row("Active subs", figure(result.health, (h) => String(h.activeSubscriptionsCount))),

    row(
      "Failed payments detected",
      figure(
        result.failedInvoices,
        (f) => `${f.count}, ${formatCents(f.totalCents, cur)}`,
      ),
    ),
    row(
      "Expiring cards",
      figure(
        result.expiringCards,
        (e) => `${e.count}, ${formatCents(e.mrrAtRiskCents, cur)} MRR at risk`,
      ),
    ),
    row(
      "Past-due subscriptions",
      figure(
        result.pastDueSubscriptions,
        (p) => `${p.count}, ${formatCents(p.totalCents, cur)}`,
      ),
    ),
    row("Voluntary churn", figure(result.health, (h) => formatBps(h.voluntaryChurnRateBps))),
    row("Involuntary churn", figure(result.health, (h) => formatBps(h.involuntaryChurnRateBps))),
    row(
      "Open disputes",
      figure(result.disputes, (d) => `${d.open.count}, ${formatCents(d.open.totalCents, cur)}`),
    ),
    row(
      "Disputes accepted without response",
      figure(result.disputes, (d) => String(d.acceptedWithoutFighting.count)),
    ),
    disputeWinRate === null ? "" : row("Dispute win rate", disputeWinRate),
    advisory ? row("Card Updater", advisory) : "",

    `<p><a href="${link}">View full audit</a></p>`,
    `<p>You are receiving this because the monthly audit is switched on in your Foxhound audit settings. Switch it off there at any time.</p>`,
  ]
    .filter(Boolean)
    .join("\n");

  return { subject: `${MONTHLY_AUDIT_SUBJECT}: ${periodMonth}`, bodyHtml };
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
export async function monthlyAuditCandidates(db: Db): Promise<MonthlyAuditAccountRow[]> {
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
export async function primaryConnection(
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
export async function priorTotals(
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

/**
 * Claim this account's slot for this month. A non-null id means this caller may
 * run and send.
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
 */
export async function claimMonthSlot(
  db: Db,
  accountId: string,
  periodMonth: string,
  now: Date,
  cronRunId: string | null,
): Promise<string | null> {
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
    return id;
  } catch {
    // The unique index rejected it: this account already has this month's row.
    const [retaken] = await db
      .update(auditDigestRuns)
      .set({ status: "pending", error: null })
      .where(
        and(
          eq(auditDigestRuns.accountId, accountId),
          eq(auditDigestRuns.periodMonth, periodMonth),
          eq(auditDigestRuns.status, "failed"),
        ),
      )
      .returning({ id: auditDigestRuns.id });
    return retaken?.id ?? null;
  }
}

/** The registered cron's name, shared with the alert the consumer raises. */
export const MONTHLY_AUDIT_CRON_NAME = "monthly-audit";

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
 * WHY A QUEUE (job_97878f0d1fde). Since #123 the audit's Stripe reads page to
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
  | "failed";

export interface MonthlyAuditAccountOutcome {
  status: MonthlyAuditAccountStatus;
  /** Whether the Stripe reads ran on this delivery. */
  ran: boolean;
  /** The thrown value, whole, on a failed outcome. */
  error?: unknown;
}

/**
 * The consumer half: one account, one month. Claimed by the database, audited
 * against live Stripe, persisted through phase (d), and mailed once through the
 * existing sender.
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

  const claimId = await claimMonthSlot(db, accountId, periodMonth, now, cronRunId);
  if (claimId === null) return { status: "duplicate", ran: false };

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
      periodMonth,
    });
    await sendTransactionalEmail(env, {
      to: account.notificationEmail,
      subject: email.subject,
      bodyHtml: email.bodyHtml,
    });
    mailed = true;

    await db
      .update(auditDigestRuns)
      .set({ totals, status: "sent", sentAt: now })
      .where(eq(auditDigestRuns.id, claimId));
    return { status: "sent", ran };
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
  if (outcome.status !== "failed") return "ack";

  console.error(
    `monthly audit: account ${message.accountId} (${message.periodMonth}) failed on attempt ${attempts}:`,
    outcome.error,
  );
  if (attempts > AUDIT_QUEUE_MAX_RETRIES) {
    const error =
      outcome.error instanceof Error ? outcome.error.message : "monthly audit failed";
    await alertCronFailure(
      env,
      getDb(env),
      { cronName: MONTHLY_AUDIT_CRON_NAME, runId: message.cronRunId, error },
      now,
    );
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
