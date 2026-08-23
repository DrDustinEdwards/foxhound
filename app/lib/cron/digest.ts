import { and, count, desc, eq, gte, isNull, isNotNull, like, notInArray, sql } from "drizzle-orm";

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
import { processEmailJob } from "~/lib/email/dispatch";
import { isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import { accountProcessingEligibleCondition } from "~/lib/cron/recovery-tick";

import {
  buildDigestEmail,
  DIGEST_SENDER_FALLBACK,
  DIGEST_TEMPLATE,
  digestSubject,
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

/** Legacy's window: seven days back from the tick. */
export const DIGEST_WINDOW_MS = 7 * DAY_MS;

/** Legacy takes the top three at-risk customers. */
export const DIGEST_HIGH_RISK_LIMIT = 3;

/** Legacy's at-risk band for the Intelligence section: `health_score <= 33`. */
export const DIGEST_HIGH_RISK_MAX_SCORE = 33;

export interface DigestRunResult {
  sent: number;
  skipped: number;
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
  const rows = await db
    .select({
      accountId: accounts.id,
      notificationEmail: accounts.notificationEmail,
      senderName: sql<string | null>`(
        select ${stripeConnections.senderName} from ${stripeConnections}
        where ${stripeConnections.accountId} = ${accounts.id}
          and ${stripeConnections.isPrimary} = 1
          and ${stripeConnections.disconnectedAt} is null
        limit 1
      )`,
      hasConnection: sql<number>`(
        select count(*) from ${stripeConnections}
        where ${stripeConnections.accountId} = ${accounts.id}
          and ${stripeConnections.isPrimary} = 1
          and ${stripeConnections.disconnectedAt} is null
      )`,
    })
    .from(accounts)
    .where(and(eq(accounts.digestEnabled, true), accountProcessingEligibleCondition()));

  return rows
    .filter((r) => r.notificationEmail !== null && Number(r.hasConnection) > 0)
    .map((r) => ({
      accountId: r.accountId,
      notificationEmail: r.notificationEmail as string,
      senderName: r.senderName,
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
  const result: DigestRunResult = { sent: 0, skipped: 0 };
  const windowStart = new Date(now.getTime() - DIGEST_WINDOW_MS);

  for (const account of await queryDigestAccounts(db)) {
    try {
      if (await hasDigestThisWeek(db, account.accountId, windowStart)) {
        result.skipped += 1;
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
          fromName: account.senderName ?? DIGEST_SENDER_FALLBACK,
          subject: digestSubject({ now, intelligenceActive, disputesActive }),
          bodyHtml: buildDigestEmail({
            ...numbers,
            senderName: account.senderName,
            intelligenceActive,
            disputesActive,
            highRiskCustomers: numbers.highRisk,
            now,
            dashboardUrl: `${env.BETTER_AUTH_URL ?? ""}/dashboard`,
          }),
          template: DIGEST_TEMPLATE,
          // Empty, as session 48's merchant notice does: the merchant audience
          // renders no unsubscribe, so there is no token to mint.
          unsubscribeToken: "",
          // The claim's carrier is the email_sends row this produces, keyed on
          // (account, template, window). The key here identifies the WEEK the
          // digest is for, so a redelivery within one run cannot double-send.
          idempotencyKey: `weekly-digest:${account.accountId}:${windowStart.toISOString().slice(0, 10)}`,
          // MERCHANT audience: no CAN-SPAM footer, no unsubscribe headers, no
          // suppression gate (339 binding 4). Legacy DOES attach an unsubscribe
          // here, and that is the recorded divergence: `email_suppressions` is
          // keyed by address, so one click would silence this merchant's
          // recovery and sequence-complete notices too.
          audience: "merchant",
          physicalAddress: env.PHYSICAL_ADDRESS ?? "",
          cronRunId: null,
        },
        null,
      );

      if (outcome.status !== "sent") {
        result.skipped += 1;
        continue;
      }
      result.sent += 1;
    } catch (err) {
      console.error(
        `weekly digest failed for account ${account.accountId}:`,
        err instanceof Error ? err.message : err,
      );
      result.skipped += 1;
    }
  }
  return result;
}

export function describeWeeklyDigestRun(result: DigestRunResult): string {
  return `${result.sent} sent, ${result.skipped} skipped`;
}
