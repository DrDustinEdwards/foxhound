import { and, asc, desc, eq, gte, inArray, isNull, like, lte, ne, or, sql } from "drizzle-orm";

import { byAccount, byAccountActive } from "~/db/scope";
import type { Db } from "~/db";
import {
  accounts,
  expiringCardAlerts,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  stripeConnections,
  winBackSequences,
} from "~/db";
import type { DeclineCategory } from "~/lib/constants";

// Recovery-surface read models (Phase 5 slice 5b): failed payments, their
// recovery_steps timeline, win-back sequences, and expiring-card alerts. Every
// query is account-scoped and read-only; nothing here writes to any table.

export type FailedPaymentRow = typeof failedPayments.$inferSelect;
export type RecoveryStepRow = typeof recoverySteps.$inferSelect;
export type RecoveredPaymentRow = typeof recoveredPayments.$inferSelect;
export type WinBackSequenceRow = typeof winBackSequences.$inferSelect;
export type ExpiringCardAlertRow = typeof expiringCardAlerts.$inferSelect;

/** Every non-noise failed payment for the account, newest first. */
export async function listFailedPayments(db: Db, accountId: string): Promise<FailedPaymentRow[]> {
  const rows = await db
    .select()
    .from(failedPayments)
    .where(
      and(
        byAccountActive(failedPayments.accountId, failedPayments.deletedAt, accountId),
        eq(failedPayments.isRenewalNoise, false),
      ),
    );
  return [...rows].sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime());
}

export type FailedPaymentSort = "newest" | "oldest" | "amount_desc" | "amount_asc";

export interface FailedPaymentFilters {
  search: string | null;
  status: string | null;
  declineCategory: string | null;
  sort: FailedPaymentSort;
  page: number;
}

export interface FailedPaymentListResult {
  payments: FailedPaymentRow[];
  totalCount: number;
  page: number;
  totalPages: number;
}

const FAILED_PAYMENT_PAGE_SIZE = 50;

/** The filtered, sorted, paginated /recovery/payments list. Every filter and
 *  the sort run in SQL, never a client-side pass over the full account. */
export async function listFilteredFailedPayments(
  db: Db,
  accountId: string,
  filters: FailedPaymentFilters,
): Promise<FailedPaymentListResult> {
  const conditions = [
    byAccountActive(failedPayments.accountId, failedPayments.deletedAt, accountId),
    eq(failedPayments.isRenewalNoise, false),
  ];
  if (filters.search) {
    const term = `%${filters.search}%`;
    const searchCondition = or(like(failedPayments.customerName, term), like(failedPayments.customerEmail, term));
    if (searchCondition) conditions.push(searchCondition);
  }
  if (filters.status) conditions.push(eq(failedPayments.status, filters.status));
  if (filters.declineCategory) conditions.push(eq(failedPayments.declineCategory, filters.declineCategory));
  const where = and(...conditions);

  const [{ n: totalCount }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(failedPayments)
    .where(where);

  const totalPages = Math.max(1, Math.ceil(Number(totalCount) / FAILED_PAYMENT_PAGE_SIZE));
  const page = Math.min(Math.max(1, filters.page), totalPages);

  const orderBy =
    filters.sort === "oldest"
      ? [asc(failedPayments.detectedAt)]
      : filters.sort === "amount_desc"
        ? [desc(failedPayments.amountCents)]
        : filters.sort === "amount_asc"
          ? [asc(failedPayments.amountCents)]
          : [desc(failedPayments.detectedAt)];

  const payments = await db
    .select()
    .from(failedPayments)
    .where(where)
    .orderBy(...orderBy)
    .limit(FAILED_PAYMENT_PAGE_SIZE)
    .offset((page - 1) * FAILED_PAYMENT_PAGE_SIZE);

  return { payments, totalCount: Number(totalCount), page, totalPages };
}

/** Only the in-progress (status='active') sequences, newest first. */
export async function listActiveFailedPayments(db: Db, accountId: string): Promise<FailedPaymentRow[]> {
  const all = await listFailedPayments(db, accountId);
  return all.filter((f) => f.status === "active");
}

export interface FailedPaymentDetail {
  failedPayment: FailedPaymentRow;
  steps: RecoveryStepRow[];
  recovery: RecoveredPaymentRow | null;
}

/** The full timeline for one failed payment, scoped to the account. Null when
 *  the id does not exist or belongs to another account (the route 404s on null). */
export async function getFailedPaymentDetail(
  db: Db,
  accountId: string,
  failedPaymentId: string,
): Promise<FailedPaymentDetail | null> {
  const rows = await db
    .select()
    .from(failedPayments)
    .where(and(eq(failedPayments.id, failedPaymentId), eq(failedPayments.accountId, accountId)))
    .limit(1);
  const failedPayment = rows[0];
  if (!failedPayment) return null;

  const [steps, recoveries] = await Promise.all([
    db
      .select()
      .from(recoverySteps)
      .where(
        and(eq(recoverySteps.failedPaymentId, failedPaymentId), eq(recoverySteps.accountId, accountId)),
      ),
    db
      .select()
      .from(recoveredPayments)
      .where(
        and(
          eq(recoveredPayments.failedPaymentId, failedPaymentId),
          eq(recoveredPayments.accountId, accountId),
        ),
      ),
  ]);

  return {
    failedPayment,
    steps: [...steps].sort((a, b) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0)),
    recovery: recoveries[0] ?? null,
  };
}

/** Every recovery_steps row across a set of failed payments (the /recovery/sequences
 *  queue view fetches steps for all active sequences in one query). */
export async function listStepsForFailedPayments(
  db: Db,
  accountId: string,
  failedPaymentIds: string[],
): Promise<RecoveryStepRow[]> {
  if (failedPaymentIds.length === 0) return [];
  return db
    .select()
    .from(recoverySteps)
    .where(
      and(eq(recoverySteps.accountId, accountId), inArray(recoverySteps.failedPaymentId, failedPaymentIds)),
    );
}

/** Win-back sequences for the account, newest first. */
export async function listWinbackSequences(db: Db, accountId: string): Promise<WinBackSequenceRow[]> {
  const rows = await db
    .select()
    .from(winBackSequences)
    .where(byAccount(winBackSequences.accountId, accountId));
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Expiring-card alerts for the account, soonest expiry first. */
export async function listExpiringCardAlerts(
  db: Db,
  accountId: string,
): Promise<ExpiringCardAlertRow[]> {
  const rows = await db
    .select()
    .from(expiringCardAlerts)
    .where(byAccountActive(expiringCardAlerts.accountId, expiringCardAlerts.deletedAt, accountId));
  return [...rows].sort(
    (a, b) => a.expiresYear * 12 + a.expiresMonth - (b.expiresYear * 12 + b.expiresMonth),
  );
}

// ============================================================================
// Dashboard window read model (TASK-foxhound-recovery-surface-parity.md Phase
// 1: the Foxhound equivalent of legacy's fetchDashboardData). Every query here
// is called with an optional cutoff (null = all time), so the SAME functions
// serve both the range-following and the always-30d call the dashboard makes
// in parallel (app/lib/dashboard/recovery-window.server.ts composes them; this
// file only owns the SQL). Renewal noise is excluded everywhere failed_payments
// is read directly, matching every other Recovery query in this file.
// ============================================================================

const RECENT_FAILED_PAYMENTS_LIMIT = 8;

/** The `limit` most recent failed payments detected on/after `cutoffMs` (or
 *  all time when null), renewal noise excluded. Feeds the dashboard's recent-
 *  activity preview (full detail lives at /recovery/payments). */
export async function listRecentFailedPayments(
  db: Db,
  accountId: string,
  cutoffMs: number | null,
  limit: number = RECENT_FAILED_PAYMENTS_LIMIT,
): Promise<FailedPaymentRow[]> {
  const conditions = [
    byAccountActive(failedPayments.accountId, failedPayments.deletedAt, accountId),
    eq(failedPayments.isRenewalNoise, false),
  ];
  if (cutoffMs !== null) conditions.push(gte(failedPayments.detectedAt, new Date(cutoffMs)));
  return db
    .select()
    .from(failedPayments)
    .where(and(...conditions))
    .orderBy(desc(failedPayments.detectedAt))
    .limit(limit);
}

/** Failed payments detected on/after `cutoffMs` (or all time when null),
 *  detected_at + decline_category only. Feeds category breakdown/stats and the
 *  daily recovery-rate trend. Called TWICE by the composed window (once with
 *  the caller's own range cutoff, once with a fixed trailing-30-day cutoff for
 *  the per-category sparklines) rather than reusing one result for both, so a
 *  sub-30-day range never starves the sparkline of real history the way
 *  legacy's reused query silently did. */
export async function listFailedDaily(
  db: Db,
  accountId: string,
  cutoffMs: number | null,
): Promise<{ detectedAt: Date; declineCategory: DeclineCategory }[]> {
  const conditions = [
    byAccountActive(failedPayments.accountId, failedPayments.deletedAt, accountId),
    eq(failedPayments.isRenewalNoise, false),
  ];
  if (cutoffMs !== null) conditions.push(gte(failedPayments.detectedAt, new Date(cutoffMs)));
  const rows = await db
    .select({ detectedAt: failedPayments.detectedAt, declineCategory: failedPayments.declineCategory })
    .from(failedPayments)
    .where(and(...conditions));
  return rows.map((r) => ({ ...r, declineCategory: r.declineCategory as DeclineCategory }));
}

/** Recovered payments on/after `cutoffMs` (or all time when null), joined to
 *  their failed payment for detected_at + decline_category (renewal noise
 *  excluded via the join). Feeds recovered revenue, recovery-days/timing, and
 *  the recovered side of category stats. */
export async function listRecoveredWithFailureContext(
  db: Db,
  accountId: string,
  cutoffMs: number | null,
): Promise<
  { recoveredAt: Date; amountCents: number; currency: string; detectedAt: Date; declineCategory: DeclineCategory }[]
> {
  const conditions = [eq(recoveredPayments.accountId, accountId), eq(failedPayments.isRenewalNoise, false)];
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

/** Counts of other failed payments for each of the given customer ids
 *  (renewal noise excluded), for the "repeat failure" indicator. Direct port
 *  of legacy's counting logic. */
export async function countPreviousFailuresByCustomer(
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
        inArray(failedPayments.stripeCustomerId, stripeCustomerIds),
      ),
    );
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.stripeCustomerId] = (counts[r.stripeCustomerId] ?? 0) + 1;
  return counts;
}

/** Executed, non-cancelled email steps (renewal noise excluded), with the
 *  decline category of their failed payment. UNSCOPED by range, matching
 *  legacy's own emailCategoryPerformance/openRate/clickRate query exactly (it
 *  carries no date filter at all, verified against the actual legacy source,
 *  not inferred). */
export async function listExecutedEmailSteps(
  db: Db,
  accountId: string,
): Promise<{ declineCategory: DeclineCategory; openedAt: Date | null; clickedAt: Date | null }[]> {
  const rows = await db
    .select({
      declineCategory: failedPayments.declineCategory,
      openedAt: recoverySteps.openedAt,
      clickedAt: recoverySteps.clickedAt,
    })
    .from(recoverySteps)
    .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
    .where(
      and(
        eq(recoverySteps.accountId, accountId),
        eq(failedPayments.isRenewalNoise, false),
        like(recoverySteps.stepType, "email_%"),
        sql`${recoverySteps.executedAt} is not null`,
        ne(recoverySteps.result, "cancelled"),
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
  const conditions = [eq(winBackSequences.accountId, accountId), eq(winBackSequences.status, "reactivated")];
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

export async function getConnectionSummary(db: Db, accountId: string): Promise<ConnectionSummary | null> {
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
    .where(
      and(
        eq(stripeConnections.accountId, accountId),
        eq(stripeConnections.isPrimary, true),
        isNull(stripeConnections.disconnectedAt),
      ),
    )
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

/** Most recent recovered_at across the account (renewal noise excluded),
 *  unscoped by range: "last recovery" is always "ever", not windowed. */
export async function getMostRecentRecoveryAt(db: Db, accountId: string): Promise<Date | null> {
  const rows = await db
    .select({ recoveredAt: recoveredPayments.recoveredAt })
    .from(recoveredPayments)
    .innerJoin(failedPayments, eq(failedPayments.id, recoveredPayments.failedPaymentId))
    .where(and(eq(recoveredPayments.accountId, accountId), eq(failedPayments.isRenewalNoise, false)))
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
        isNull(recoverySteps.executedAt),
        gte(recoverySteps.scheduledAt, now),
        lte(recoverySteps.scheduledAt, until),
      ),
    )
    .orderBy(asc(recoverySteps.scheduledAt))
    .limit(UPCOMING_STEPS_LIMIT);
}
