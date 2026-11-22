import { appOrigin } from "~/lib/app-origin";
import { groupSumByCurrency, type CurrencyAmount } from "~/lib/money/totals";
import { and, count, desc, eq, gte, isNull, isNotNull, notInArray, sql } from "drizzle-orm";
import { inList, likeStartsWith } from "@dustinedwards/site-runtime/d1";

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
import { accountProcessingEligibleCondition } from "~/lib/cron/due-steps";

import {
  DIGEST_TEMPLATE,
  digestContent,
  resolveDigestCurrency,
  type DigestNumbers,
} from "~/lib/recovery/digest-email";
import { errorMessage } from "@dustinedwards/site-runtime/log";

// THE WEEKLY DIGEST CRON.

export const DIGEST_WINDOW_MS = 7 * DAY_MS;

/**
 * THE CLAIM WINDOW, which is the DATA window minus a day, and the reason is a
 * defect this constant exists to fix (376 item 13, a reversal of 350 binding
 * 3).
 *
 * The row is therefore inside the window by exactly the duration of last week's
 * run, the claim reads "already sent", and the digest skips itself.
 */
const DIGEST_CLAIM_WINDOW_MS = DIGEST_WINDOW_MS - DAY_MS;

const DIGEST_HIGH_RISK_LIMIT = 3;

const DIGEST_HIGH_RISK_MAX_SCORE = 33;

/**
 * What happened to one account's digest, by name. The send's own status from
 * processEmailJob ("sent", "suppressed", "blocked", "failed", "duplicate"),
 * "already_sent" when this week's digest is already out, and "error" when
 * building the digest threw before a send was attempted.
 */
type DigestOutcomeStatus = EmailSendStatus | "already_sent" | "error";

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

/** The accounts a digest is owed to. */
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
        inList(
          stripeConnections.accountId,
          withEmail.map((a) => a.accountId),
        ),
        eq(stripeConnections.isPrimary, true),
        isNull(stripeConnections.disconnectedAt),
      ),
    );
  const byAccount = new Map(connections.map((c) => [c.accountId, c.senderName]));

  return withEmail
    .filter((a) => byAccount.has(a.accountId))
    .map((a) => ({
      accountId: a.accountId,
      notificationEmail: a.notificationEmail,
      senderName: byAccount.get(a.accountId) ?? null,
    }));
}

async function hasDigestThisWeek(db: Db, accountId: string, windowStart: Date): Promise<boolean> {
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
): Promise<
  DigestNumbers & {
    highRisk: { name: string; mrrCents: number | null; currency: string | null }[];
    personalOutreachCount: number;
  }
> {
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
        .select({
          amountCents: recoveredPayments.amountCents,
          currency: recoveredPayments.currency,
        })
        .from(recoveredPayments)
        .where(
          and(
            eq(recoveredPayments.accountId, accountId),
            gte(recoveredPayments.recoveredAt, windowStart),
          ),
        ),
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
            likeStartsWith(recoverySteps.stepType, "email_"),
            gte(recoverySteps.executedAt, windowStart),
          ),
        ),
      db
        .select({ n: count() })
        .from(winBackSequences)
        .where(
          and(eq(winBackSequences.accountId, accountId), eq(winBackSequences.status, "active")),
        ),
      db
        .select({ n: count() })
        .from(expiringCardAlerts)
        .where(
          and(
            eq(expiringCardAlerts.accountId, accountId),
            isNull(expiringCardAlerts.deletedAt),
            eq(expiringCardAlerts.reason, "card_expiring"),
          ),
        ),
      db
        .select({ amountCents: disputes.amountCents, currency: disputes.currency })
        .from(disputes)
        .where(
          and(
            eq(disputes.accountId, accountId),
            notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
          ),
        ),
    ]);

  const [highRisk, outreachRows] = await Promise.all([
    db
      .select({
        name: customerContext.customerName,
        mrrCents: customerContext.mrrContributionCents,
        currency: customerContext.currency,
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
      .limit(DIGEST_HIGH_RISK_LIMIT),
    db
      .select({ n: count() })
      .from(customerContext)
      .where(
        and(
          eq(customerContext.accountId, accountId),
          eq(customerContext.recommendedAction, "personal_outreach"),
        ),
      ),
  ]);

  return {
    totalFailed: failedRows.length,
    totalRecovered: recoveredRows.length,
    recoveredRevenue: totalsOf(recoveredRows),
    atRiskRevenue: totalsOf(failedRows),
    activeCount: activeRows[0]?.n ?? 0,
    emailsSent: emailRows[0]?.n ?? 0,
    winBackCount: winBackRows[0]?.n ?? 0,
    expiringCardCount: expiringRows[0]?.n ?? 0,
    openDisputeCount: disputeRows.length,
    openDisputeAmounts: totalsOf(disputeRows),
    currency: resolveDigestCurrency(recoveredRows, failedRows),
    highRisk: highRisk.map((c) => ({
      name: c.name ?? "(unnamed)",
      mrrCents: c.mrrCents,
      currency: c.currency,
    })),
    personalOutreachCount: outreachRows[0]?.n ?? 0,
  };
}

/** Per-currency totals of rows that may lack an amount or currency. */
function totalsOf(
  rows: { amountCents: number | null; currency: string | null }[],
): CurrencyAmount[] {
  return groupSumByCurrency(
    rows.flatMap((r) =>
      r.amountCents != null && r.currency ? [{ currency: r.currency, cents: r.amountCents }] : [],
    ),
  );
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
  // TWO WINDOWS, DELIBERATELY DIFFERENT, and the difference is the whole fix.
  const claimWindowStart = new Date(now.getTime() - DIGEST_CLAIM_WINDOW_MS);
  const baseUrl = appOrigin(env);

  for (const account of await queryDigestAccounts(db)) {
    try {
      if (await hasDigestThisWeek(db, account.accountId, claimWindowStart)) {
        record(account.accountId, "already_sent");
        continue;
      }

      const numbers = await collectDigestNumbers(db, account.accountId, windowStart);
      const disputesActive = numbers.openDisputeCount > 0;

      const outcome = await processEmailJob(
        env,
        {
          accountId: account.accountId,
          to: account.notificationEmail,
          ...digestContent({
            ...numbers,
            senderName: account.senderName,
            disputesActive,
            highRiskCustomers: numbers.highRisk,
            personalOutreachCount: numbers.personalOutreachCount,
            now,
            baseUrl,
          }),
          template: DIGEST_TEMPLATE,
          // RECOVA'S UNSUBSCRIBE.
          unsubscribeToken: await signUnsubscribeToken(env, {
            email: account.notificationEmail,
            accountId: account.accountId,
            list: "digest",
          }),
          // The claim's carrier is the email_sends row this produces, keyed on
          // (account, template, window). The key here identifies the WEEK the
          // digest is for, so a redelivery within one run cannot double-send.
          idempotencyKey: `weekly-digest:${account.accountId}:${windowStart.toISOString().slice(0, 10)}`,
          audience: "digest",
          physicalAddress: env.PHYSICAL_ADDRESS ?? "",
          cronRunId: null,
        },
        null,
      );

      record(account.accountId, outcome.status);
    } catch (err) {
      console.error(`weekly digest failed for account ${account.accountId}:`, errorMessage(err));
      record(account.accountId, "error");
    }
  }
  return result;
}

export function describeWeeklyDigestRun(result: DigestRunResult): string {
  return `${result.sent} sent, ${result.skipped} skipped`;
}
