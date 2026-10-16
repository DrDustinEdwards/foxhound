import { and, count, desc, eq, gte, inArray, isNull, isNotNull, like, notInArray, sql } from "drizzle-orm";

import type { Db } from "~/db";
import {
  accounts,
  customerContext,
  disputes,
  emailSends,
  expiringCardAlerts,
  failedPayments,
  getDb,
  recoveredPayments,
  recoverySteps,
  stripeConnections,
  winBackSequences,
} from "~/db";
import { DAY_MS } from "~/lib/constants";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";
import { processEmailJob, type EmailSendStatus } from "~/lib/email/dispatch";
import { signUnsubscribeToken } from "~/lib/email/unsubscribe-token";
import { isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import { accountProcessingEligibleCondition } from "~/lib/cron/recovery-tick";

import {
  DIGEST_TEMPLATE,
  digestContent,
  resolveDigestCurrency,
  type DigestNumbers,
} from "~/lib/recovery/digest-email";

// THE WEEKLY DIGEST CRON. Ported from legacy's
// app/api/cron/weekly-digest/route.ts (blob `b6ff2a8c`, 22,247 bytes).
//
// MONDAY 08:00 UTC, legacy's cadence, which needed a NEW wrangler trigger
// (`0 8 * * 1`): this is the first Foxhound cron that cannot reuse an existing
// expression. The CronLockDurableObject lease in run.ts stops two ticks
// overlapping.
//
// THE WEEK IS A ROLLING SEVEN DAYS, not a calendar week. Legacy computes
// `now - 7*24h` and every windowed query is `>= that`. Ported as written; the
// arithmetic is UTC-safe because it is pure milliseconds (342 binding 2).
//
// NULL IS OFF. `digest_enabled` is the ONE toggle with that semantic (337
// binding 3): legacy selects `.eq('digest_enabled', true)`, so an account that
// never opted in is not mailed.

/** Legacy's window: seven days back from the tick. THE DATA WINDOW, and it does
 *  not move (350 binding 1, restated by 376 item 13). */
export const DIGEST_WINDOW_MS = 7 * DAY_MS;

/**
 * THE CLAIM WINDOW, which is the DATA window minus a day, and the reason is a
 * defect this constant exists to fix (376 item 13, a reversal of 350 binding 3).
 *
 * WHAT WENT WRONG. The claim asked "is there a digest send newer than
 * `now - 7d`", with `now` fixed at run start. Last week's run started at the
 * same clock time, so `now - 7d` lands on last week's run START, while last
 * week's `email_sends` row was written a moment AFTER that start, when the send
 * completed. The row is therefore inside the window by exactly the duration of
 * last week's run, the claim reads "already sent", and the digest skips itself.
 * Every other week, for nearly every account, and nondeterministically: whether
 * it fires depends on how long the previous run took.
 *
 * WHY A DAY RATHER THAN A SECOND. The gap being corrected for is bounded by how
 * long one run can take, and Cloudflare caps a Cron Trigger invocation at 15
 * minutes of wall time, so any slack over 15 minutes closes it. A day is 96
 * times that bound and needs no revisiting if the job gets slower; and it costs
 * nothing, because the job is weekly, so the only run that can land inside a
 * six-day claim window is one somebody triggered by hand.
 *
 * WHY NOT AN ISO WEEK KEY, the other option on the table: 350 binding 1 defines
 * this job's week as a ROLLING seven days and every data query is built on that.
 * Keying the claim on a calendar week would leave the job with two different
 * meanings of "week", and would change a shipped behaviour (a digest sent last
 * Friday no longer blocks Monday's) that no ruling has asked to change.
 */
export const DIGEST_CLAIM_WINDOW_MS = DIGEST_WINDOW_MS - DAY_MS;

/** Legacy takes the top three at-risk customers. */
export const DIGEST_HIGH_RISK_LIMIT = 3;

/** Legacy's at-risk band for the Intelligence section: `health_score <= 33`. */
export const DIGEST_HIGH_RISK_MAX_SCORE = 33;

/**
 * What happened to one account's digest, by name (RULES.md 3.16: a send path
 * returns a named outcome, never null). The send's own status from
 * processEmailJob ("sent", "suppressed", "blocked", "failed", "duplicate"),
 * "already_sent" when this week's digest is already out, and "error" when
 * building the digest threw before a send was attempted.
 */
export type DigestOutcomeStatus = EmailSendStatus | "already_sent" | "error";

export interface DigestRunResult {
  sent: number;
  skipped: number;
  outcomes: { accountId: string; status: DigestOutcomeStatus }[];
}

export interface DigestAccount {
  accountId: string;
  notificationEmail: string;
  senderName: string | null;
}

/**
 * The accounts a digest is owed to.
 *
 * Four gates, all legacy's: the toggle is TRUE (never NULL), a notification
 * email exists, a live primary connection exists, and the account is not demo
 * and not paused. The demo and paused halves both arrive through
 * `accountProcessingEligibleCondition()`, which already carries the
 * `DEMO_ACCOUNT_ID_PREFIX` notLike alongside the paused and cancelled gates;
 * writing a second copy of that predicate here would read as defence in depth
 * while proving nothing (session 52's reversal 11).
 */
export async function queryDigestAccounts(db: Db): Promise<DigestAccount[]> {
  const candidates = await db
    .select({
      accountId: accounts.id,
      notificationEmail: accounts.notificationEmail,
    })
    .from(accounts)
    .where(and(eq(accounts.digestEnabled, true), accountProcessingEligibleCondition()));

  const withEmail = candidates.filter(
    (a): a is { accountId: string; notificationEmail: string } => a.notificationEmail !== null,
  );
  if (withEmail.length === 0) return [];

  // LEGACY'S OWN SHAPE: one batch fetch of the primary connections, then a Map
  // lookup per account, "instead of N round-trips inside the per-account loop"
  // as its comment puts it.
  const connections = await db
    .select({
      accountId: stripeConnections.accountId,
      senderName: stripeConnections.senderName,
    })
    .from(stripeConnections)
    .where(
      and(
        inArray(
          stripeConnections.accountId,
          withEmail.map((a) => a.accountId),
        ),
        eq(stripeConnections.isPrimary, true),
        isNull(stripeConnections.disconnectedAt),
      ),
    );
  const byAccount = new Map(connections.map((c) => [c.accountId, c.senderName]));

  // A missing or disconnected primary connection SKIPS the account, as legacy
  // does: a digest about a Stripe account Foxhound can no longer read is a
  // report on nothing.
  return withEmail
    .filter((a) => byAccount.has(a.accountId))
    .map((a) => ({
      accountId: a.accountId,
      notificationEmail: a.notificationEmail,
      senderName: byAccount.get(a.accountId) ?? null,
    }));
}

/**
 * THE PER-WEEK CLAIM, and legacy has none.
 *
 * Legacy relies on its weekly schedule plus `acquireLock` and has no column, no
 * check and no per-account guard, so a second invocation in the same week sends
 * a second digest. Foxhound already records every send in `email_sends`, so the
 * claim needs NO MIGRATION: an existing row for this account with this template
 * inside the window means the digest is already out.
 *
 * IT IS A CHECK-THEN-ACT, NOT A DATABASE-LEVEL UNIQUE, and saying so matters.
 * What makes it safe is the CronLockDurableObject lease, which stops two ticks
 * running at once; the two are independent layers and each is reached alone in
 * the plants.
 *
 * THE CALLER PASSES THE CLAIM WINDOW, NOT THE DATA WINDOW (376 item 13). This
 * function takes whatever start it is given and has no opinion, which is why the
 * defect lived in the caller rather than here; see DIGEST_CLAIM_WINDOW_MS.
 */
export async function hasDigestThisWeek(
  db: Db,
  accountId: string,
  windowStart: Date,
): Promise<boolean> {
  const rows = await db
    .select({ id: emailSends.id })
    .from(emailSends)
    .where(
      and(
        eq(emailSends.accountId, accountId),
        eq(emailSends.template, DIGEST_TEMPLATE),
        gte(emailSends.createdAt, windowStart),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Every number on the digest, from the tables that answer it. */
export async function collectDigestNumbers(
  db: Db,
  accountId: string,
  windowStart: Date,
): Promise<DigestNumbers & { highRisk: { name: string; mrrCents: number | null }[] }> {
  const [failedRows, recoveredRows, activeRows, emailRows, winBackRows, expiringRows, disputeRows] =
    await Promise.all([
      db
        .select({ amountCents: failedPayments.amountCents, currency: failedPayments.currency })
        .from(failedPayments)
        .where(
          and(
            eq(failedPayments.accountId, accountId),
            isNull(failedPayments.deletedAt),
            gte(failedPayments.detectedAt, windowStart),
          ),
        ),
      db
        .select({ amountCents: recoveredPayments.amountCents, currency: recoveredPayments.currency })
        .from(recoveredPayments)
        .where(
          and(
            eq(recoveredPayments.accountId, accountId),
            gte(recoveredPayments.recoveredAt, windowStart),
          ),
        ),
      // NO WINDOW: legacy counts CURRENT active sequences, not this week's.
      db
        .select({ n: count() })
        .from(failedPayments)
        .where(
          and(
            eq(failedPayments.accountId, accountId),
            isNull(failedPayments.deletedAt),
            eq(failedPayments.status, "active"),
          ),
        ),
      db
        .select({ n: count() })
        .from(recoverySteps)
        .where(
          and(
            eq(recoverySteps.accountId, accountId),
            isNull(recoverySteps.deletedAt),
            isNotNull(recoverySteps.executedAt),
            like(recoverySteps.stepType, "email_%"),
            gte(recoverySteps.executedAt, windowStart),
          ),
        ),
      // NO WINDOW, as legacy has it.
      db
        .select({ n: count() })
        .from(winBackSequences)
        .where(
          and(eq(winBackSequences.accountId, accountId), eq(winBackSequences.status, "active")),
        ),
      // NO WINDOW AT ALL: legacy counts every alert row ever recorded for the
      // account, not the ones raised this week. Ported as found.
      db
        .select({ n: count() })
        .from(expiringCardAlerts)
        .where(
          and(
            eq(expiringCardAlerts.accountId, accountId),
            isNull(expiringCardAlerts.deletedAt),
          ),
        ),
      db
        .select({ amountCents: disputes.amountCents })
        .from(disputes)
        .where(
          and(
            eq(disputes.accountId, accountId),
            notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
          ),
        ),
    ]);

  const highRisk = await db
    .select({
      name: customerContext.customerName,
      mrrCents: customerContext.mrrContributionCents,
    })
    .from(customerContext)
    .where(
      and(
        eq(customerContext.accountId, accountId),
        sql`${customerContext.healthScore} is not null`,
        sql`${customerContext.healthScore} <= ${DIGEST_HIGH_RISK_MAX_SCORE}`,
      ),
    )
    .orderBy(desc(customerContext.mrrContributionCents))
    .limit(DIGEST_HIGH_RISK_LIMIT);

  return {
    totalFailed: failedRows.length,
    totalRecovered: recoveredRows.length,
    recoveredRevenueCents: recoveredRows.reduce((sum, r) => sum + (r.amountCents ?? 0), 0),
    atRiskRevenueCents: failedRows.reduce((sum, r) => sum + (r.amountCents ?? 0), 0),
    activeCount: activeRows[0]?.n ?? 0,
    emailsSent: emailRows[0]?.n ?? 0,
    winBackCount: winBackRows[0]?.n ?? 0,
    expiringCardCount: expiringRows[0]?.n ?? 0,
    openDisputeCount: disputeRows.length,
    openDisputeCents: disputeRows.reduce((sum, d) => sum + (d.amountCents ?? 0), 0),
    currency: resolveDigestCurrency(recoveredRows, failedRows),
    // Legacy's `(unnamed)` for a customer_context row with no name.
    highRisk: highRisk.map((c) => ({ name: c.name ?? "(unnamed)", mrrCents: c.mrrCents })),
  };
}

/** One weekly run. */
export async function runWeeklyDigest(env: Env, now: Date): Promise<DigestRunResult> {
  const db = getDb(env);
  const result: DigestRunResult = { sent: 0, skipped: 0, outcomes: [] };
  const record = (accountId: string, status: DigestOutcomeStatus): void => {
    result.outcomes.push({ accountId, status });
    if (status === "sent") result.sent += 1;
    else result.skipped += 1;
  };
  const windowStart = new Date(now.getTime() - DIGEST_WINDOW_MS);
  // TWO WINDOWS, DELIBERATELY DIFFERENT, and the difference is the whole fix
  // (376 item 13). The DATA window stays legacy's seven days; the CLAIM window
  // is a day shorter so last week's send row, written moments after last week's
  // run started, falls OUTSIDE it and this week's digest is not skipped by its
  // own predecessor.
  const claimWindowStart = new Date(now.getTime() - DIGEST_CLAIM_WINDOW_MS);
  const baseUrl = env.BETTER_AUTH_URL ?? "";

  for (const account of await queryDigestAccounts(db)) {
    try {
      if (await hasDigestThisWeek(db, account.accountId, claimWindowStart)) {
        record(account.accountId, "already_sent");
        continue;
      }

      const numbers = await collectDigestNumbers(db, account.accountId, windowStart);
      const intelligenceActive = await isIntelligenceEntitled(db, account.accountId);
      // LEGACY GATES THIS ON THE DISPUTES PRODUCT AND FOXHOUND HAS NO SUCH
      // ENTITLEMENT: there is no DISPUTES_PRODUCT and no account_subscriptions
      // row for it, so only the second half of legacy's condition survives.
      const disputesActive = numbers.openDisputeCount > 0;

      const outcome = await processEmailJob(
        env,
        {
          accountId: account.accountId,
          to: account.notificationEmail,
          ...digestContent({
            ...numbers,
            senderName: account.senderName,
            intelligenceActive,
            disputesActive,
            highRiskCustomers: numbers.highRisk,
            now,
            baseUrl,
          }),
          template: DIGEST_TEMPLATE,
          // RECOVA'S UNSUBSCRIBE (E23). Recova runs checkAndRegisterUnsubscribe
          // on the notification address and wraps the digest with its token.
          // Foxhound's token is the signed /u/ token every unsubscribe link
          // carries, for this address and this account; processEmailJob's
          // suppression gate is Recova's check, run before the send.
          unsubscribeToken: await signUnsubscribeToken(env, {
            email: account.notificationEmail,
            accountId: account.accountId,
          }),
          // The claim's carrier is the email_sends row this produces, keyed on
          // (account, template, window). The key here identifies the WEEK the
          // digest is for, so a redelivery within one run cannot double-send.
          idempotencyKey: `weekly-digest:${account.accountId}:${windowStart.toISOString().slice(0, 10)}`,
          // The DIGEST audience: Recova's footer with Unsubscribe and the postal
          // address, on this merchant mail only (RULES.md 3.16). A missing
          // address refuses the send, as on customer mail.
          audience: "digest",
          physicalAddress: env.PHYSICAL_ADDRESS ?? "",
          cronRunId: null,
        },
        null,
      );

      record(account.accountId, outcome.status);
    } catch (err) {
      console.error(
        `weekly digest failed for account ${account.accountId}:`,
        err instanceof Error ? err.message : err,
      );
      record(account.accountId, "error");
    }
  }
  return result;
}

export function describeWeeklyDigestRun(result: DigestRunResult): string {
  return `${result.sent} sent, ${result.skipped} skipped`;
}
