import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { byAccount, byAccountActive } from "~/db/scope";
import {
  type Db,
  disputes,
  expiringCardAlerts,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  winBackSequences,
} from "~/db";
import {
  FAILED_PAYMENT_STATUS_ACTIVE,
  FAILED_PAYMENT_STATUS_CANCELLED,
  FAILED_PAYMENT_STATUS_UNRECOVERED,
  type DeclineCategory,
} from "~/lib/constants";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";
import { notCancelledResult } from "./dashboard-queries.server";

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
  /** Merchant-stopped sequences (S7's "Stop recovery", ruling 262 decision two).
   *  Counted separately because operator-terminated is not the same outcome as
   *  exhausted, and folding it into failedUnrecovered would overstate how often
   *  the engine ran out of road. */
  cancelled: number;
}

/** Tally raw status strings into the canonical PaymentStatusCounts shape.
 *  Exported so a caller with its own already-fetched rows (e.g. the
 *  status-pill counts, which respect every filter except status) can reuse
 *  the exact same counting logic getGlobalPaymentStatusCounts uses. */
export function tallyStatusCounts(statuses: string[]): PaymentStatusCounts {
  let active = 0;
  let recovered = 0;
  let failedUnrecovered = 0;
  let cancelled = 0;
  for (const s of statuses) {
    if (s === FAILED_PAYMENT_STATUS_ACTIVE) active++;
    else if (s === "recovered") recovered++;
    else if (s === FAILED_PAYMENT_STATUS_UNRECOVERED) failedUnrecovered++;
    else if (s === FAILED_PAYMENT_STATUS_CANCELLED) cancelled++;
  }
  return { all: statuses.length, active, recovered, failedUnrecovered, cancelled };
}

/** Status counts for the WHOLE account, ignoring every filter: the five
 *  summary cards' "account state at a glance" row, unaffected by
 *  search/category/amount/time.
 *
 *  ONE card reads a different member of this same result depending on the
 *  selected status pill, "Showing", which is legacy's own behavior at its
 *  PaymentsClient.tsx call site (279). That is a different KEY off this
 *  unfiltered tally and never a filtered query, so this function stays
 *  status-independent and still runs once. This comment read
 *  "search/category/amount/time/status ... so it always reads the same" until
 *  2026-08-14, which stopped being true when the Showing card landed. */
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
  /** Legacy's open-dispute badge (PaymentDetailClient.tsx 243-251 at blob
   *  7f54aa45): this customer's disputes that are still in play. Legacy also
   *  gated the badge on an account_products entitlement; 298 dropped that table
   *  as vestigial and 304 ruled the badge renders on the dispute predicate
   *  ALONE, so this is the whole gate. */
  openDisputes: { id: string }[];
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
  const [previousFailures, customerRecovered, openDisputes] = await Promise.all([
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
    // Open disputes for THIS customer. "Open" is derived from
    // RESOLVED_DISPUTE_STATES, the same constant isDisputeResolved reads, so the
    // SQL and the helper cannot drift: adding a resolved state updates both.
    db
      .select({ id: disputes.id })
      .from(disputes)
      .where(
        and(
          eq(disputes.accountId, accountId),
          eq(disputes.stripeCustomerId, failedPayment.stripeCustomerId),
          notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
        ),
      )
      .orderBy(desc(disputes.createdAt)),
  ]);

  return {
    failedPayment,
    steps: [...steps].sort((a, b) => (a.stepNumber ?? 0) - (b.stepNumber ?? 0)),
    recovery: recoveries[0] ?? null,
    previousFailures,
    estimatedLtvCents: estimateCustomerLtvCents(customerRecovered.map((r) => r.amountCents)),
    openDisputes,
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

/** Every recovery_steps row across a set of failed payments (the /recovery/sequence
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

/** Ids per step-count read: D1 binds at most 100 parameters a statement, and
 *  the account id takes one. */
const STEP_COUNT_IDS_PER_READ = 90;

/** Executed and total recovery_steps per failed payment, for the CSV export's
 *  Steps Executed and Total Steps (Recova's lib/csv.ts: steps with an executed
 *  time, and all steps). Scoped to the account, soft-deleted steps skipped. A
 *  payment with no steps is absent from the map. */
export async function countStepsForFailedPayments(
  db: Db,
  accountId: string,
  failedPaymentIds: string[],
): Promise<Map<string, { executed: number; total: number }>> {
  const counts = new Map<string, { executed: number; total: number }>();
  for (let i = 0; i < failedPaymentIds.length; i += STEP_COUNT_IDS_PER_READ) {
    const ids = failedPaymentIds.slice(i, i + STEP_COUNT_IDS_PER_READ);
    const rows = await db
      .select({
        failedPaymentId: recoverySteps.failedPaymentId,
        executed: count(recoverySteps.executedAt),
        total: count(),
      })
      .from(recoverySteps)
      .where(
        and(
          byAccountActive(recoverySteps.accountId, recoverySteps.deletedAt, accountId),
          inArray(recoverySteps.failedPaymentId, ids),
        ),
      )
      .groupBy(recoverySteps.failedPaymentId);
    for (const row of rows) counts.set(row.failedPaymentId, { executed: row.executed, total: row.total });
  }
  return counts;
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

/** Every executed (non-canceled) recovery_steps row for the account, across
 *  every failed payment, joined to its decline category - the account-wide
 *  step-performance read model for /recovery/sequence. */
export async function listExecutedRecoverySteps(db: Db, accountId: string): Promise<ExecutedRecoveryStepRow[]> {
  const rows = await db
    .select({
      id: recoverySteps.id,
      stepType: recoverySteps.stepType,
      executedAt: recoverySteps.executedAt,
      result: recoverySteps.result,
      openedAt: recoverySteps.openedAt,
      clickedAt: recoverySteps.clickedAt,
      clickSuspectReason: recoverySteps.clickSuspectReason,
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
