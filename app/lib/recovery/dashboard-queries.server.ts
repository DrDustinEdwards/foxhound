// Dashboard read models split out of queries.server.ts: recent failures and their outcomes,
// win-back counts, onboarding and connection summaries, ROI, deliverability and upcoming steps.
// Account-scoped and read-only, like the rest of the recovery queries.

import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { inList, likeStartsWith } from "@dustinedwards/site-runtime/d1";
import { byAccountActive } from "~/db/scope";
import { stepPendingCondition } from "~/lib/cron/due-steps";
import { activePrimaryConnectionWhere } from "~/lib/stripe/connections.server";
import { billableRecoveryRowConditions, exemptionForgaveRecovery } from "~/db/billable";
import {
  type Db,
  accounts,
  billingLineItems,
  emailSends,
  emailSuppressions,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  stripeConnections,
  winBackSequences,
} from "~/db";
import { BILLABLE_ATTRIBUTION_KINDS, type DeclineCategory } from "~/lib/constants";
import { SUPPRESSION_REASON } from "~/lib/email/events";
import { type FailedPaymentRow } from "./queries.server";

// Dashboard window read model. Every query here is called with an optional cutoff (null = all
// time), so the SAME functions serve both the range-following and the always-30d call the dashboard
// makes in parallel (app/lib/dashboard/recovery-window.server.ts composes them; this file only owns
// the SQL).

const RECENT_FAILED_PAYMENTS_LIMIT = 8;

/** The account's live, non-renewal-noise failures detected on/after `cutoffMs` (all time when null). */
function windowedFailures(accountId: string, cutoffMs: number | null) {
  return and(
    byAccountActive(failedPayments.accountId, failedPayments.deletedAt, accountId),
    eq(failedPayments.isRenewalNoise, false),
    cutoffMs === null ? undefined : gte(failedPayments.detectedAt, new Date(cutoffMs)),
  );
}

/** The `limit` most recent failed payments detected on/after `cutoffMs` (or
 *  all time when null), renewal noise excluded. Feeds the dashboard's recent-
 *  activity preview (full detail lives at /recovery/payments). */
export async function listRecentFailedPayments(
  db: Db,
  accountId: string,
  cutoffMs: number | null,
  limit: number = RECENT_FAILED_PAYMENTS_LIMIT,
): Promise<FailedPaymentRow[]> {
  return db
    .select()
    .from(failedPayments)
    .where(windowedFailures(accountId, cutoffMs))
    .orderBy(desc(failedPayments.detectedAt))
    .limit(limit);
}

export interface FailureOutcomeRow {
  detectedAt: Date;
  declineCategory: DeclineCategory;
  /** Null when this failure has not recovered. */
  recoveredAt: Date | null;
}

/**
 * Every failure detected on/after `cutoffMs` (or all time when null), LEFT JOINed to whether/when
 * it has since recovered. ONE cohort: total count, recovered count, per-category stats,
 * recovery-days/timing, and the category breakdown/sparkline/daily-failure-trend all derive from
 * these SAME rows, filtered the SAME way, never two populations anchored on two different
 * timestamps.
 */
export async function listFailuresWithOutcome(
  db: Db,
  accountId: string,
  cutoffMs: number | null,
): Promise<FailureOutcomeRow[]> {
  const rows = await db
    .select({
      detectedAt: failedPayments.detectedAt,
      declineCategory: failedPayments.declineCategory,
      recoveredAt: recoveredPayments.recoveredAt,
    })
    .from(failedPayments)
    .leftJoin(recoveredPayments, eq(recoveredPayments.failedPaymentId, failedPayments.id))
    .where(windowedFailures(accountId, cutoffMs));
  return rows.map((r) => ({ ...r, declineCategory: r.declineCategory as DeclineCategory }));
}

/**
 * Recovered payments on/after `cutoffMs` (or all time when null), joined to their failed payment
 * for detected_at + decline_category (renewal noise excluded via the join). A cash-flow population,
 * deliberately anchored on WHEN THE MONEY CAME BACK: feeds recovered revenue and the recovered-
 * payments raw array (the revenue-trend chart's daily bars, and the daily recovery-rate chart's
 * calendar-day recovered counts).
 */
export async function listRecoveredWithFailureContext(
  db: Db,
  accountId: string,
  cutoffMs: number | null,
): Promise<
  {
    recoveredAt: Date;
    amountCents: number;
    currency: string;
    detectedAt: Date;
    declineCategory: DeclineCategory;
  }[]
> {
  const conditions = [
    eq(recoveredPayments.accountId, accountId),
    eq(failedPayments.isRenewalNoise, false),
  ];
  if (cutoffMs !== null) conditions.push(gte(recoveredPayments.recoveredAt, new Date(cutoffMs)));
  const rows = await db
    .select({
      recoveredAt: recoveredPayments.recoveredAt,
      amountCents: recoveredPayments.amountCents,
      currency: recoveredPayments.currency,
      detectedAt: failedPayments.detectedAt,
      declineCategory: failedPayments.declineCategory,
    })
    .from(recoveredPayments)
    .innerJoin(failedPayments, eq(failedPayments.id, recoveredPayments.failedPaymentId))
    .where(and(...conditions));
  return rows.map((r) => ({ ...r, declineCategory: r.declineCategory as DeclineCategory }));
}

/**
 * TOTAL failed payments per customer id (renewal noise excluded), feeding the "repeat failure"
 * indicator. A caller showing "N prior" for one row must subtract that row itself via
 * priorFailureCount(); it cannot be done here, because a customer can have several rows on the same
 * page and this map is keyed by customer, not by row.
 */
export async function countFailuresByCustomer(
  db: Db,
  accountId: string,
  stripeCustomerIds: string[],
): Promise<Record<string, number>> {
  if (stripeCustomerIds.length === 0) return {};
  const rows = await db
    .select({ stripeCustomerId: failedPayments.stripeCustomerId })
    .from(failedPayments)
    .where(
      and(
        byAccountActive(failedPayments.accountId, failedPayments.deletedAt, accountId),
        eq(failedPayments.isRenewalNoise, false),
        inList(failedPayments.stripeCustomerId, stripeCustomerIds),
      ),
    );
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.stripeCustomerId] = (counts[r.stripeCustomerId] ?? 0) + 1;
  return counts;
}

// `result != 'cancelled'` is NOT the same as "not canceled" in SQL: for a row whose result IS NULL
// the comparison evaluates to NULL, which a WHERE clause treats as false, so the row is dropped. An
// executed step that has not yet recorded a result is a legitimately counted send, so it must
// survive.
export function notCancelledResult(): SQL {
  return sql`(${recoverySteps.result} is null or ${recoverySteps.result} != 'cancelled')`;
}

/**
 * Executed, non-canceled email steps (renewal noise excluded), with the decline category of their
 * failed payment.
 */
export async function listExecutedEmailSteps(
  db: Db,
  accountId: string,
): Promise<
  {
    declineCategory: DeclineCategory;
    executedAt: Date | null;
    openedAt: Date | null;
    clickedAt: Date | null;
  }[]
> {
  const rows = await db
    .select({
      declineCategory: failedPayments.declineCategory,
      executedAt: recoverySteps.executedAt,
      openedAt: recoverySteps.openedAt,
      clickedAt: recoverySteps.clickedAt,
      clickSuspectReason: recoverySteps.clickSuspectReason,
    })
    .from(recoverySteps)
    .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
    .where(
      and(
        eq(recoverySteps.accountId, accountId),
        eq(failedPayments.isRenewalNoise, false),
        likeStartsWith(recoverySteps.stepType, "email_"),
        sql`${recoverySteps.executedAt} is not null`,
        notCancelledResult(),
      ),
    );
  return rows.map((r) => ({ ...r, declineCategory: r.declineCategory as DeclineCategory }));
}

/** Win-back sequences reactivated on/after `cutoffMs` (or all time when
 *  null): amount + currency only, for the reactivated-revenue aggregate. */
export async function listReactivatedWinbacks(
  db: Db,
  accountId: string,
  cutoffMs: number | null,
): Promise<{ amountCents: number | null; currency: string | null }[]> {
  const conditions = [
    eq(winBackSequences.accountId, accountId),
    eq(winBackSequences.status, "reactivated"),
  ];
  if (cutoffMs !== null) conditions.push(gte(winBackSequences.reactivatedAt, new Date(cutoffMs)));
  return db
    .select({ amountCents: winBackSequences.amountCents, currency: winBackSequences.currency })
    .from(winBackSequences)
    .where(and(...conditions));
}

/** Count of currently-active (status='active') win-back sequences. Unscoped
 *  by range: "active right now" is current state, not a historical count. */
export async function countActiveWinbacks(db: Db, accountId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(winBackSequences)
    .where(and(eq(winBackSequences.accountId, accountId), eq(winBackSequences.status, "active")));
  return Number(n);
}

/** The account's primary, still-connected Stripe connection plus the account
 *  fields the dashboard header needs. Null when nothing is connected. */
export interface ConnectionSummary {
  name: string | null;
  stripeUserId: string;
  connectedAt: Date | null;
  lastWebhookAt: Date | null;
  mrrEstimateCents: number | null;
}

export interface DashboardOnboardingProfile {
  notificationEmail: string | null;
  onboardingCompleted: boolean;
  liveSendsEnabled: boolean;
  /** The sender name on the primary, still-connected Stripe connection. */
  senderName: string | null;
}

export async function getDashboardOnboardingProfile(
  db: Db,
  accountId: string,
): Promise<DashboardOnboardingProfile> {
  const [[account], [connection]] = await Promise.all([
    db
      .select({
        notificationEmail: accounts.notificationEmail,
        onboardingCompleted: accounts.onboardingCompleted,
        liveSendsEnabled: accounts.liveSendsEnabled,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1),
    db
      .select({ senderName: stripeConnections.senderName })
      .from(stripeConnections)
      .where(activePrimaryConnectionWhere(accountId))
      .limit(1),
  ]);
  return {
    notificationEmail: account?.notificationEmail ?? null,
    onboardingCompleted: account?.onboardingCompleted ?? false,
    liveSendsEnabled: account?.liveSendsEnabled ?? false,
    senderName: connection?.senderName ?? null,
  };
}

export async function getConnectionSummary(
  db: Db,
  accountId: string,
): Promise<ConnectionSummary | null> {
  const [account] = await db
    .select({ name: accounts.name, mrrEstimateCents: accounts.mrrEstimateCents })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const [connection] = await db
    .select({
      stripeUserId: stripeConnections.stripeUserId,
      connectedAt: stripeConnections.connectedAt,
      lastWebhookAt: stripeConnections.lastWebhookAt,
    })
    .from(stripeConnections)
    .where(activePrimaryConnectionWhere(accountId))
    .limit(1);
  if (!connection) return null;
  return {
    name: account?.name ?? null,
    stripeUserId: connection.stripeUserId,
    connectedAt: connection.connectedAt,
    lastWebhookAt: connection.lastWebhookAt,
    mrrEstimateCents: account?.mrrEstimateCents ?? null,
  };
}

/**
 * Billable-attributed, matured recoveries on/after `windowStartMs` (or all time when null), for the
 * ROI widget. Reuses `billableRecoveryRowConditions` directly from app/db/billable.ts, the SAME
 * predicate the real billing run uses (attribution in BILLABLE_ATTRIBUTION_KINDS, 30-day maturity,
 * not refunded/disputed/deleted). It does leave out a fee a billing exemption forgave, which is
 * never billed.
 */
export async function listBillableRecoveredForRoi(
  db: Db,
  accountId: string,
  nowMs: number,
  windowStartMs: number | null,
): Promise<{ amountCents: number; refundedCents: number; currency: string }[]> {
  const conditions = [
    billableRecoveryRowConditions(accountId, nowMs),
    // A row already invoiced stays, whatever exemption came later; one not yet
    // invoiced stays only while no billing exemption has forgiven its fee
    // (app/db/billable.ts, exemptionForgaveRecovery), since it will never be billed.
    or(
      exists(
        db
          .select({ one: sql`1` })
          .from(billingLineItems)
          .where(eq(billingLineItems.recoveredPaymentId, recoveredPayments.id)),
      ),
      exemptionForgaveRecovery(nowMs),
    ) as SQL,
  ];
  if (windowStartMs !== null)
    conditions.push(gte(recoveredPayments.recoveredAt, new Date(windowStartMs)));
  return db
    .select({
      amountCents: recoveredPayments.amountCents,
      refundedCents: recoveredPayments.refundedCents,
      currency: recoveredPayments.currency,
    })
    .from(recoveredPayments)
    .where(and(...conditions));
}

/**
 * Attributed recoveries since `sinceMs`, for the ROI panel's "This month": the attribution kinds
 * Foxhound bills, not refunded, disputed or deleted, and NO maturity filter, so a recovery made
 * this month shows this month. Display only: billing reads getBillableRecoveries
 * (app/db/billable.ts), which this does not touch.
 */
export async function listAttributedRecoveredSince(
  db: Db,
  accountId: string,
  sinceMs: number,
): Promise<{ amountCents: number; refundedCents: number; currency: string }[]> {
  return db
    .select({
      amountCents: recoveredPayments.amountCents,
      refundedCents: recoveredPayments.refundedCents,
      currency: recoveredPayments.currency,
    })
    .from(recoveredPayments)
    .where(
      and(
        eq(recoveredPayments.accountId, accountId),
        inArray(recoveredPayments.attributionKind, BILLABLE_ATTRIBUTION_KINDS),
        gte(recoveredPayments.recoveredAt, new Date(sinceMs)),
        isNull(recoveredPayments.refundedAt),
        isNull(recoveredPayments.disputedAt),
        isNull(recoveredPayments.deletedAt),
      ),
    );
}

export interface DeliverabilityCounts {
  sent: number;
  bounced: number;
  complaints: number;
}

/**
 * The deliverability panel's figures since `cutoffMs` (all time when null): emails this account
 * sent (email_sends, status sent) and the bounce and complaint suppressions recorded against it.
 */
export async function getDeliverabilityCounts(
  db: Db,
  accountId: string,
  cutoffMs: number | null,
): Promise<DeliverabilityCounts> {
  const since = cutoffMs === null ? null : new Date(cutoffMs);
  const suppressed = (reason: string) =>
    db
      .select({ n: count() })
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.accountId, accountId),
          eq(emailSuppressions.reason, reason),
          since ? gte(emailSuppressions.suppressedAt, since) : undefined,
        ),
      );
  const [[sent], [bounced], [complaints]] = await Promise.all([
    db
      .select({ n: count() })
      .from(emailSends)
      .where(
        and(
          eq(emailSends.accountId, accountId),
          eq(emailSends.status, "sent"),
          since ? gte(emailSends.sentAt, since) : undefined,
        ),
      ),
    suppressed(SUPPRESSION_REASON.bounce),
    suppressed(SUPPRESSION_REASON.complaint),
  ]);
  return { sent: sent?.n ?? 0, bounced: bounced?.n ?? 0, complaints: complaints?.n ?? 0 };
}

/** Most recent recovered_at across the account (renewal noise excluded),
 *  unscoped by range: "last recovery" is always "ever", not windowed. */
export async function getMostRecentRecoveryAt(db: Db, accountId: string): Promise<Date | null> {
  const rows = await db
    .select({ recoveredAt: recoveredPayments.recoveredAt })
    .from(recoveredPayments)
    .innerJoin(failedPayments, eq(failedPayments.id, recoveredPayments.failedPaymentId))
    .where(
      and(eq(recoveredPayments.accountId, accountId), eq(failedPayments.isRenewalNoise, false)),
    )
    .orderBy(desc(recoveredPayments.recoveredAt))
    .limit(1);
  return rows[0]?.recoveredAt ?? null;
}

export interface UpcomingStepRow {
  id: string;
  stepType: string;
  scheduledAt: Date;
  customerName: string | null;
  customerEmail: string;
  amountCents: number;
  currency: string;
}

const UPCOMING_STEPS_LIMIT = 8;

/** Unexecuted recovery_steps scheduled within [now, now + withinMs], soonest
 *  first, joined to their failed payment for customer/amount. Feeds the
 *  RecoveryQueue surface. Unscoped by range: "coming up next" is always
 *  relative to now. */
export async function listUpcomingSteps(
  db: Db,
  accountId: string,
  nowMs: number,
  withinMs: number,
): Promise<UpcomingStepRow[]> {
  const now = new Date(nowMs);
  const until = new Date(nowMs + withinMs);
  return db
    .select({
      id: recoverySteps.id,
      stepType: recoverySteps.stepType,
      scheduledAt: recoverySteps.scheduledAt,
      customerName: failedPayments.customerName,
      customerEmail: failedPayments.customerEmail,
      amountCents: failedPayments.amountCents,
      currency: failedPayments.currency,
    })
    .from(recoverySteps)
    .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
    .where(
      and(
        eq(recoverySteps.accountId, accountId),
        // What the cron will send: pending (stepDueCondition's pieces) on a still-active, undeleted payment.
        stepPendingCondition(),
        eq(failedPayments.status, "active"),
        isNull(failedPayments.deletedAt),
        gte(recoverySteps.scheduledAt, now),
        lte(recoverySteps.scheduledAt, until),
      ),
    )
    .orderBy(asc(recoverySteps.scheduledAt))
    .limit(UPCOMING_STEPS_LIMIT);
}
