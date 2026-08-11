import { and, asc, desc, eq, gte, inArray, isNull, like, lte, ne, or, sql, type SQL } from "drizzle-orm";

import { byAccount, byAccountActive } from "~/db/scope";
import { billableRecoveryRowConditions } from "~/db/billable";
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
export type FailedPaymentPageSize = 10 | 25 | 50 | 100 | "all";

/** The filter dimensions that narrow WHICH payments match, independent of
 *  status, sort, or pagination. Shared by the paginated list, the status-pill
 *  counts (which respect every filter except status, the dimension the pills
 *  themselves iterate over), and the header stats line. */
export interface FailedPaymentFilterInput {
  search: string | null;
  declineCategory: string | null;
  /** Only payments detected on/after this cutoff (the "time" dropdown). */
  detectedAfterMs: number | null;
  amountMinCents: number | null;
  amountMaxCents: number | null;
}

export interface FailedPaymentFilters extends FailedPaymentFilterInput {
  status: string | null;
  sort: FailedPaymentSort;
  page: number;
  pageSize: FailedPaymentPageSize;
}

export interface FailedPaymentListResult {
  payments: FailedPaymentRow[];
  totalCount: number;
  page: number;
  totalPages: number;
  pageSize: FailedPaymentPageSize;
}

export const DEFAULT_PAYMENT_PAGE_SIZE: FailedPaymentPageSize = 50;

function baseFailedPaymentConditions(accountId: string) {
  return [
    byAccountActive(failedPayments.accountId, failedPayments.deletedAt, accountId),
    eq(failedPayments.isRenewalNoise, false),
  ];
}

/** Mutates `conditions` in place, adding one clause per active filter
 *  dimension. Shared by every query that needs to match "the payments the
 *  current filters describe" without status (list/summary/pills) or with it
 *  (the paginated list itself adds status separately, see below). */
function applyFailedPaymentFilters(conditions: unknown[], filters: FailedPaymentFilterInput): void {
  if (filters.search) {
    const term = `%${filters.search}%`;
    const searchCondition = or(
      like(failedPayments.customerName, term),
      like(failedPayments.customerEmail, term),
      like(failedPayments.planName, term),
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  if (filters.declineCategory) conditions.push(eq(failedPayments.declineCategory, filters.declineCategory));
  if (filters.detectedAfterMs !== null) {
    conditions.push(gte(failedPayments.detectedAt, new Date(filters.detectedAfterMs)));
  }
  if (filters.amountMinCents !== null) conditions.push(gte(failedPayments.amountCents, filters.amountMinCents));
  if (filters.amountMaxCents !== null) conditions.push(lte(failedPayments.amountCents, filters.amountMaxCents));
}

/** The filtered, sorted, paginated /recovery/payments list. Every filter and
 *  the sort run in SQL, never a client-side pass over the full account.
 *  `pageSize: "all"` (the "rows per page" control's all-in-one option)
 *  returns every matching row on page 1, no limit/offset. */
export async function listFilteredFailedPayments(
  db: Db,
  accountId: string,
  filters: FailedPaymentFilters,
): Promise<FailedPaymentListResult> {
  const conditions = baseFailedPaymentConditions(accountId);
  applyFailedPaymentFilters(conditions, filters);
  if (filters.status) conditions.push(eq(failedPayments.status, filters.status));
  const where = and(...conditions);

  const [{ n: totalCount }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(failedPayments)
    .where(where);

  const isAll = filters.pageSize === "all";
  const totalCountNum = Number(totalCount);
  const pageSize: number = filters.pageSize === "all" ? Math.max(1, totalCountNum) : filters.pageSize;
  const totalPages = isAll ? 1 : Math.max(1, Math.ceil(totalCountNum / pageSize));
  const page = isAll ? 1 : Math.min(Math.max(1, filters.page), totalPages);

  const orderBy =
    filters.sort === "oldest"
      ? [asc(failedPayments.detectedAt)]
      : filters.sort === "amount_desc"
        ? [desc(failedPayments.amountCents)]
        : filters.sort === "amount_asc"
          ? [asc(failedPayments.amountCents)]
          : [desc(failedPayments.detectedAt)];

  const payments = isAll
    ? await db.select().from(failedPayments).where(where).orderBy(...orderBy)
    : await db
        .select()
        .from(failedPayments)
        .where(where)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset((page - 1) * pageSize);

  return { payments, totalCount: Number(totalCount), page, totalPages, pageSize: filters.pageSize };
}

export interface AmountBounds {
  minCents: number;
  maxCents: number;
}

const AMOUNT_BOUNDS_STEP_CENTS = 10_000;

/** The dual-handle amount range's absolute bounds: 0 up to the account's
 *  actual highest failed-payment amount, rounded up to the nearest $100 (a
 *  hardcoded ceiling would either clip a real merchant's larger invoices or
 *  waste most of the slider's range on a small one). */
export async function getAmountBounds(db: Db, accountId: string): Promise<AmountBounds> {
  const [row] = await db
    .select({ max: sql<number>`max(${failedPayments.amountCents})` })
    .from(failedPayments)
    .where(and(...baseFailedPaymentConditions(accountId)));
  const maxAmount = row?.max ?? 0;
  const maxCents = Math.max(AMOUNT_BOUNDS_STEP_CENTS, Math.ceil(maxAmount / AMOUNT_BOUNDS_STEP_CENTS) * AMOUNT_BOUNDS_STEP_CENTS);
  return { minCents: 0, maxCents };
}

export interface PaymentStatusCounts {
  all: number;
  active: number;
  recovered: number;
  failedUnrecovered: number;
}

/** Tally raw status strings into the canonical PaymentStatusCounts shape.
 *  Exported so a caller with its own already-fetched rows (e.g. the
 *  status-pill counts, which respect every filter except status) can reuse
 *  the exact same counting logic getGlobalPaymentStatusCounts uses. */
export function tallyStatusCounts(statuses: string[]): PaymentStatusCounts {
  let active = 0;
  let recovered = 0;
  let failedUnrecovered = 0;
  for (const s of statuses) {
    if (s === "active") active++;
    else if (s === "recovered") recovered++;
    else if (s === "failed_unrecovered") failedUnrecovered++;
  }
  return { all: statuses.length, active, recovered, failedUnrecovered };
}

/** Status counts for the WHOLE account, ignoring every filter (the five
 *  summary cards' "account state at a glance" row, deliberately unaffected
 *  by search/category/amount/time/status so it always reads the same). */
export async function getGlobalPaymentStatusCounts(db: Db, accountId: string): Promise<PaymentStatusCounts> {
  const rows = await db
    .select({ status: failedPayments.status })
    .from(failedPayments)
    .where(and(...baseFailedPaymentConditions(accountId)));
  return tallyStatusCounts(rows.map((r) => r.status));
}

export interface PaymentSummaryRow {
  status: string;
  amountCents: number;
}

/**
 * Every payment matching search/category/amount/time (deliberately NOT
 * status, NOT pagination): status + amount only. Feeds two different, both
 * server-computed things from ONE query, so status-pill counts and the
 * header stats line can never drift from what the paginated list itself
 * would return:
 *   - the status-filter pills' counts: tally these rows by status, ignoring
 *     the status filter itself (so each pill shows "how many would match if
 *     you picked this status, given your other filters").
 *   - the header stats line: the caller further filters these same rows by
 *     status (if one is selected) to compute at-risk/recovered/rate for
 *     exactly what the current filters describe.
 */
export async function listPaymentSummaryRows(
  db: Db,
  accountId: string,
  filters: FailedPaymentFilterInput,
): Promise<PaymentSummaryRow[]> {
  const conditions = baseFailedPaymentConditions(accountId);
  applyFailedPaymentFilters(conditions, filters);
  return db
    .select({ status: failedPayments.status, amountCents: failedPayments.amountCents })
    .from(failedPayments)
    .where(and(...conditions));
}

/** Only the in-progress (status='active') sequences, newest first. */
export async function listActiveFailedPayments(db: Db, accountId: string): Promise<FailedPaymentRow[]> {
  const all = await listFailedPayments(db, accountId);
  return all.filter((f) => f.status === "active");
}

export interface PreviousFailureRow {
  id: string;
  detectedAt: Date;
  declineCategory: string;
  status: string;
  amountCents: number;
  currency: string;
}

export interface FailedPaymentDetail {
  failedPayment: FailedPaymentRow;
  steps: RecoveryStepRow[];
  recovery: RecoveredPaymentRow | null;
  /** Legacy's "Previous failures" list: the same customer's other failed
   *  payments, newest first, capped at five
   *  (app/(app)/recovery/payments/[id]/page.tsx at 6034a8ba). */
  previousFailures: PreviousFailureRow[];
  /** Legacy's estimated LTV, computed FRESH: the mean of this customer's
   *  recovered payments times twelve. Null below legacy's own threshold of TWO
   *  recovered payments, which is the gate legacy writes
   *  (`allCustomerPayments.length >= 2`), not a guess.
   *
   *  failed_payments.customer_ltv_cents is deliberately NOT reused: it holds a
   *  different value, and shipping it under legacy's "est. LTV" label would put
   *  a wrong number on a money surface (ruling 253's column guard). */
  estimatedLtvCents: number | null;
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

  // Legacy's two customer-scoped reads, both account-scoped here as every read
  // in this tree is. The previous-failures query mirrors legacy exactly:
  // same stripe_customer_id, excluding THIS payment, newest first, five.
  const [previousFailures, customerRecovered] = await Promise.all([
    db
      .select({
        id: failedPayments.id,
        detectedAt: failedPayments.detectedAt,
        declineCategory: failedPayments.declineCategory,
        status: failedPayments.status,
        amountCents: failedPayments.amountCents,
        currency: failedPayments.currency,
      })
      .from(failedPayments)
      .where(
        and(
          eq(failedPayments.accountId, accountId),
          eq(failedPayments.stripeCustomerId, failedPayment.stripeCustomerId),
          ne(failedPayments.id, failedPaymentId),
          isNull(failedPayments.deletedAt),
        ),
      )
      .orderBy(desc(failedPayments.detectedAt))
      .limit(5),
    db
      .select({ amountCents: recoveredPayments.amountCents })
      .from(recoveredPayments)
      .innerJoin(failedPayments, eq(recoveredPayments.failedPaymentId, failedPayments.id))
      .where(
        and(
          eq(recoveredPayments.accountId, accountId),
          eq(failedPayments.stripeCustomerId, failedPayment.stripeCustomerId),
        ),
      ),
  ]);

  return {
    failedPayment,
    steps: [...steps].sort((a, b) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0)),
    recovery: recoveries[0] ?? null,
    previousFailures,
    estimatedLtvCents: estimateCustomerLtvCents(customerRecovered.map((r) => r.amountCents)),
  };
}

/** Legacy's LTV arithmetic, lifted verbatim from
 *  app/(app)/recovery/payments/[id]/page.tsx at 6034a8ba:
 *  `(sum / length) * 12`, and only when there are at least TWO recovered
 *  payments to average. Below that legacy passes null and renders no subtext
 *  at all, so this returns null rather than inventing a one-sample mean. */
export function estimateCustomerLtvCents(amounts: number[]): number | null {
  if (amounts.length < 2) return null;
  const sum = amounts.reduce((total, cents) => total + cents, 0);
  return (sum / amounts.length) * 12;
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

export interface ExecutedRecoveryStepRow {
  id: string;
  stepType: string;
  executedAt: Date;
  result: string | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  aiSubject: string | null;
  aiBodyHtml: string | null;
  declineCategory: DeclineCategory;
  /** True when a recovered_payments row credits THIS exact step
   *  (recovered_by_step_id), the real Foxhound attribution spine - not
   *  legacy's coarse result-string check, which has no Foxhound equivalent. */
  creditedRecovery: boolean;
}

/** Every executed (non-cancelled) recovery_steps row for the account, across
 *  every failed payment, joined to its decline category - the account-wide
 *  step-performance read model for /recovery/sequences. */
export async function listExecutedRecoverySteps(db: Db, accountId: string): Promise<ExecutedRecoveryStepRow[]> {
  const rows = await db
    .select({
      id: recoverySteps.id,
      stepType: recoverySteps.stepType,
      executedAt: recoverySteps.executedAt,
      result: recoverySteps.result,
      openedAt: recoverySteps.openedAt,
      clickedAt: recoverySteps.clickedAt,
      aiSubject: recoverySteps.aiSubject,
      aiBodyHtml: recoverySteps.aiBodyHtml,
      declineCategory: failedPayments.declineCategory,
      creditedRecoveryId: recoveredPayments.id,
    })
    .from(recoverySteps)
    .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
    .leftJoin(recoveredPayments, eq(recoveredPayments.recoveredByStepId, recoverySteps.id))
    .where(
      and(
        eq(recoverySteps.accountId, accountId),
        eq(failedPayments.isRenewalNoise, false),
        sql`${recoverySteps.executedAt} is not null`,
        notCancelledResult(),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    stepType: r.stepType,
    executedAt: r.executedAt as Date,
    result: r.result,
    openedAt: r.openedAt,
    clickedAt: r.clickedAt,
    aiSubject: r.aiSubject,
    aiBodyHtml: r.aiBodyHtml,
    declineCategory: r.declineCategory as DeclineCategory,
    creditedRecovery: r.creditedRecoveryId !== null,
  }));
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

export interface FailureOutcomeRow {
  detectedAt: Date;
  declineCategory: DeclineCategory;
  /** Null when this failure has not recovered. */
  recoveredAt: Date | null;
}

/**
 * Every failure detected on/after `cutoffMs` (or all time when null), LEFT
 * JOINed to whether/when it has since recovered. ONE cohort: total count,
 * recovered count, per-category stats, recovery-days/timing, and the
 * category breakdown/sparkline/daily-failure-trend all derive from these SAME
 * rows, filtered the SAME way, never two populations anchored on two
 * different timestamps.
 *
 * TASK-foxhound-recovery-surface-parity.md Phase 1 review finding: legacy's
 * fetchDashboardData anchors its denominator (totalFailedCount,
 * categoryStats total) on detected_at, but its numerator (recoveredCount,
 * categoryStats recovered, recoveryDays/avgDaysToRecovery/timing buckets,
 * bestCategory) on a SEPARATELY range-filtered recovered_payments query
 * anchored on recovered_at. A failure detected before the window that
 * happens to recover inside it lands in legacy's numerator with no matching
 * denominator entry, which can push a category's (or the account's overall)
 * recovery rate above 100%, and skews bestCategory toward whichever category
 * the mismatch distorts hardest. Verified directly against legacy's source,
 * not ported: this function is the fix, called TWICE by the composed window
 * (once with the caller's own range cutoff, once with a fixed trailing-30-
 * day cutoff for the per-category sparklines) rather than reusing one result
 * for both, so a sub-30-day range never starves the sparkline of real
 * history either.
 */
export async function listFailuresWithOutcome(
  db: Db,
  accountId: string,
  cutoffMs: number | null,
): Promise<FailureOutcomeRow[]> {
  const conditions = [
    byAccountActive(failedPayments.accountId, failedPayments.deletedAt, accountId),
    eq(failedPayments.isRenewalNoise, false),
  ];
  if (cutoffMs !== null) conditions.push(gte(failedPayments.detectedAt, new Date(cutoffMs)));
  const rows = await db
    .select({
      detectedAt: failedPayments.detectedAt,
      declineCategory: failedPayments.declineCategory,
      recoveredAt: recoveredPayments.recoveredAt,
    })
    .from(failedPayments)
    .leftJoin(recoveredPayments, eq(recoveredPayments.failedPaymentId, failedPayments.id))
    .where(and(...conditions));
  return rows.map((r) => ({ ...r, declineCategory: r.declineCategory as DeclineCategory }));
}

/** Recovered payments on/after `cutoffMs` (or all time when null), joined to
 *  their failed payment for detected_at + decline_category (renewal noise
 *  excluded via the join). A cash-flow population, deliberately anchored on
 *  WHEN THE MONEY CAME BACK: feeds recovered revenue and the recovered-
 *  payments raw array (the revenue-trend chart's daily bars, and the daily
 *  recovery-rate chart's calendar-day recovered counts). Never used for the
 *  total/recovered/category-stats cohort math; that is
 *  listFailuresWithOutcome, anchored on WHEN THE FAILURE HAPPENED instead,
 *  deliberately a different question from this one. */
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

/**
 * TOTAL failed payments per customer id (renewal noise excluded), feeding the
 * "repeat failure" indicator.
 *
 * This returns the total, INCLUDING whichever payment is being rendered. A
 * caller showing "N prior" for one row must subtract that row itself via
 * priorFailureCount(); it cannot be done here, because a customer can have
 * several rows on the same page and this map is keyed by customer, not by row.
 *
 * The previous version of this function was named countPreviousFailuresByCustomer
 * and its comment claimed to be a "direct port of legacy's counting logic". It
 * was not: legacy decremented the tally once per on-page payment
 * (lib/payments-data.ts:174-178) and this did not, so every row with any
 * history rendered at least "+1 prior" against itself.
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
        inArray(failedPayments.stripeCustomerId, stripeCustomerIds),
      ),
    );
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.stripeCustomerId] = (counts[r.stripeCustomerId] ?? 0) + 1;
  return counts;
}

// `result != 'cancelled'` is NOT the same as "not cancelled" in SQL: for a row
// whose result IS NULL the comparison evaluates to NULL, which a WHERE clause
// treats as false, so the row is dropped. An executed step that has not yet
// recorded a result is a legitimately counted send, so it must survive. This
// spells the intent out instead.
function notCancelledResult(): SQL {
  return sql`(${recoverySteps.result} is null or ${recoverySteps.result} != 'cancelled')`;
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

/**
 * Billable-attributed, matured recoveries on/after `windowStartMs` (or all
 * time when null), for the ROI widget. Reuses `billableRecoveryRowConditions`
 * directly from app/db/billable.ts, the SAME predicate the real billing run
 * uses (attribution in BILLABLE_ATTRIBUTION_KINDS, 30-day maturity, not
 * refunded/disputed/deleted). Deliberately does NOT join billing_line_items
 * (unlike getBillableRecoveries, which excludes already-invoiced rows to
 * compute what to bill NEXT): an ROI summary should never shrink just
 * because an invoice already went out. Legacy's `recovery_method in
 * ('retry','email_click','manual')` filter is NOT ported (TASK-foxhound-
 * recovery-surface-parity.md: use BILLABLE_ATTRIBUTION_KINDS and the
 * maturity window instead).
 */
export async function listBillableRecoveredForRoi(
  db: Db,
  accountId: string,
  nowMs: number,
  windowStartMs: number | null,
): Promise<{ amountCents: number; currency: string }[]> {
  const conditions = [billableRecoveryRowConditions(accountId, nowMs)];
  if (windowStartMs !== null) conditions.push(gte(recoveredPayments.recoveredAt, new Date(windowStartMs)));
  return db
    .select({ amountCents: recoveredPayments.amountCents, currency: recoveredPayments.currency })
    .from(recoveredPayments)
    .where(and(...conditions));
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
