import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { inList } from "@dustinedwards/site-runtime/d1";
import { byAccountActive } from "~/db/scope";
import {
  type Db,
  expiringCardAlerts,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  winBackSequences,
} from "~/db";
import type { DeclineCategory } from "~/lib/constants";
import { notCancelledResult } from "./dashboard-queries.server";
import type { ExpiringCardAlertRow, RecoveryStepRow, WinBackSequenceRow } from "./queries.server";

// Recovery-surface read models for the recovery_steps timeline, win-back sequences and
// expiring-card alerts. Account-scoped and read-only.

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
      and(
        eq(recoverySteps.accountId, accountId),
        isNull(recoverySteps.deletedAt),
        inList(recoverySteps.failedPaymentId, failedPaymentIds),
      ),
    );
}

/**
 * Executed and total recovery_steps per failed payment, for the CSV export's Steps Executed and
 * Total Steps.
 */
export async function countStepsForFailedPayments(
  db: Db,
  accountId: string,
  failedPaymentIds: string[],
): Promise<Map<string, { executed: number; total: number }>> {
  const counts = new Map<string, { executed: number; total: number }>();
  if (failedPaymentIds.length === 0) return counts;
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
        inList(recoverySteps.failedPaymentId, failedPaymentIds),
      ),
    )
    .groupBy(recoverySteps.failedPaymentId);
  for (const row of rows)
    counts.set(row.failedPaymentId, { executed: row.executed, total: row.total });
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
  creditedRecovery: boolean;
}

/** Every executed (non-canceled) recovery_steps row for the account, across
 *  every failed payment, joined to its decline category - the account-wide
 *  step-performance read model for /recovery/sequence. */
export async function listExecutedRecoverySteps(
  db: Db,
  accountId: string,
): Promise<ExecutedRecoveryStepRow[]> {
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
export async function listWinbackSequences(
  db: Db,
  accountId: string,
): Promise<WinBackSequenceRow[]> {
  return db
    .select()
    .from(winBackSequences)
    .where(eq(winBackSequences.accountId, accountId))
    .orderBy(desc(winBackSequences.createdAt));
}

/** Expiring-card alerts for the account, soonest expiry first. Cards only
 *  unless `includeNoPaymentMethod`: every caller but the expiring-cards page
 *  reads the month and year as a card expiry, which a 'no_payment_method' row
 *  (a trial end) is not. */
export async function listExpiringCardAlerts(
  db: Db,
  accountId: string,
  options: { includeNoPaymentMethod?: boolean } = {},
): Promise<ExpiringCardAlertRow[]> {
  const active = byAccountActive(
    expiringCardAlerts.accountId,
    expiringCardAlerts.deletedAt,
    accountId,
  );
  const rows = await db
    .select()
    .from(expiringCardAlerts)
    .where(
      options.includeNoPaymentMethod
        ? active
        : and(active, eq(expiringCardAlerts.reason, "card_expiring")),
    );
  return [...rows].sort(
    (a, b) => a.expiresYear * 12 + a.expiresMonth - (b.expiresYear * 12 + b.expiresMonth),
  );
}
