import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";

import { byAccount, byAccountActive } from "~/db/scope";
import type { Db } from "~/db";
import {
  expiringCardAlerts,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  winBackSequences,
} from "~/db";

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
