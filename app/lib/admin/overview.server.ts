// Platform-wide health summary for /admin (overview). Every query here is
// GLOBAL (no account_id scope, this is the operator surface, not a tenant
// surface) and excludes demo accounts (DEMO_ACCOUNT_ID_PREFIX), matching the
// accountBillingEligibleCondition demo-exclusion convention in app/db/billable.ts.

import { and, asc, count, desc, eq, gte, isNull, lt, notInArray, notLike, sql } from "drizzle-orm";

import type { Db } from "~/db";
import {
  accounts,
  billingInvoices,
  cronConfig,
  cronRunHistory,
  disputes,
  failedPayments,
  mrrSnapshots,
  recoveredPayments,
  stripeConnections,
} from "~/db";
import { auditTarget, describeAuditAction, type AuditTarget } from "~/lib/admin/audit-describe";
import { listAuditLog, loadAuditLookups } from "~/lib/admin/audit-log.server";
import { groupSumByCurrency, startOfUtcMonthMs, type CurrencyAmount } from "~/lib/billing/preview.server";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";

const NOT_DEMO = notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`);

const DAY_MS = 24 * 60 * 60 * 1000;

/** How old an open dispute with no response is before it needs attention, and
 *  how far back a connection counts as new: Recova's overview (app/admin/page.tsx)
 *  used seven days for both. */
export const STALE_DISPUTE_DAYS = 7;
export const NEW_CONNECTION_DAYS = 7;

/** A ceiling on each kind of attention row, so a bad day (the brake pausing
 *  every merchant) cannot make the Overview read thousands of rows. The list
 *  shows its own first few of each kind and links on to the full view. */
const ATTENTION_LIMIT = 50;

/** Recova's Recent admin actions showed the newest ten audit rows. */
export const RECENT_ACTIONS_LIMIT = 10;

export interface PausedMerchant {
  id: string;
  name: string | null;
  /** PAUSE_REASON_BRAKE when the emergency brake paused it, PAUSE_REASON_MANUAL
   *  (or null on an older row) when an operator did (app/lib/admin/brake.ts). */
  pauseReason: string | null;
}

export interface StaleDispute {
  id: string;
  accountId: string;
  merchantName: string | null;
  amountCents: number;
  currency: string;
  reason: string;
  createdAt: Date;
  evidenceDeadline: Date | null;
}

export interface FailedFeeInvoice {
  id: string;
  accountId: string;
  merchantName: string | null;
  totalCents: number;
  currency: string;
  chargeAttemptCount: number;
  /** The last charge attempt, or when the invoice was made if none is stamped. */
  failedAt: Date;
}

export interface PlatformOverview {
  merchantCount: number;
  activeRecoveriesCount: number;
  mrrByCurrency: Array<{ currency: string; totalCents: number; accountCount: number }>;
  /** Merchants whose processing is paused and who could be resumed (not
   *  cancelled or deleted, where processing is gated anyway). */
  pausedCount: number;
  billingExemptCount: number;
  /** Stripe connections made in the last NEW_CONNECTION_DAYS and still live. */
  newConnectionsCount: number;
  /** Disputes not yet resolved, by Foxhound's dispute state machine. */
  openDisputesCount: number;
  /** How many of those are older than STALE_DISPUTE_DAYS with no response
   *  submitted, counted rather than read, so it holds past ATTENTION_LIMIT. */
  staleDisputesCount: number;
  /** Fee invoices whose charge failed and that are still unpaid, counted. */
  failedFeeInvoicesCount: number;
  /** recovered_payments since the first of this UTC month, per currency, the
   *  same read /billing's "recovered this month" makes for one merchant. */
  recoveredThisMonth: { byCurrency: CurrencyAmount[]; paymentCount: number };
  attention: {
    pausedMerchants: PausedMerchant[];
    /** Open, no response submitted, older than STALE_DISPUTE_DAYS; oldest first. */
    staleDisputes: StaleDispute[];
    /** Fee invoices whose charge failed and that are still unpaid; newest first. */
    failedFeeInvoices: FailedFeeInvoice[];
  };
  cronHealth: {
    failedLast24h: number;
    /** The failed runs themselves (newest first), so the Overview can link to
     *  each one on /admin/crons. */
    failedRuns: Array<{ id: string; cronName: string; finishedAt: Date; message: string | null }>;
    lastRunAt: Date | null;
    disabledCount: number;
  };
}

async function countMerchants(db: Db): Promise<number> {
  const rows = await db.select({ n: count() }).from(accounts).where(NOT_DEMO);
  return rows[0]?.n ?? 0;
}

async function countActiveRecoveries(db: Db): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(failedPayments)
    .innerJoin(accounts, eq(accounts.id, failedPayments.accountId))
    .where(and(eq(failedPayments.status, "active"), NOT_DEMO));
  return rows[0]?.n ?? 0;
}

/** Latest mrr_snapshots row per (non-demo) account, summed by currency. Simple
 *  per-account "latest snapshot date" read; platform scale (~hundreds of
 *  accounts pre-launch) makes an in-app group-by-max fine without a window
 *  function, matching the "small volume" posture the rest of the admin
 *  surface takes (SCHEMA.md target scale ~300 merchants). */
async function mrrUnderManagement(db: Db): Promise<PlatformOverview["mrrByCurrency"]> {
  const rows = await db
    .select({
      accountId: mrrSnapshots.accountId,
      snapshotDate: mrrSnapshots.snapshotDate,
      totalMrrCents: mrrSnapshots.totalMrrCents,
      currency: mrrSnapshots.currency,
    })
    .from(mrrSnapshots)
    .innerJoin(accounts, eq(accounts.id, mrrSnapshots.accountId))
    .where(NOT_DEMO)
    .orderBy(desc(mrrSnapshots.snapshotDate));

  const latestByAccount = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByAccount.has(row.accountId)) latestByAccount.set(row.accountId, row);
  }

  const byCurrency = new Map<string, { totalCents: number; accountCount: number }>();
  for (const row of latestByAccount.values()) {
    const entry = byCurrency.get(row.currency) ?? { totalCents: 0, accountCount: 0 };
    entry.totalCents += row.totalMrrCents;
    entry.accountCount += 1;
    byCurrency.set(row.currency, entry);
  }
  return [...byCurrency.entries()].map(([currency, v]) => ({ currency, ...v }));
}

async function cronHealth(db: Db): Promise<PlatformOverview["cronHealth"]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [failedRuns, lastRunRows, disabledRows] = await Promise.all([
    db
      .select({
        id: cronRunHistory.id,
        cronName: cronRunHistory.cronName,
        finishedAt: cronRunHistory.finishedAt,
        message: cronRunHistory.message,
      })
      .from(cronRunHistory)
      .where(and(eq(cronRunHistory.status, "failed"), gte(cronRunHistory.finishedAt, since)))
      .orderBy(desc(cronRunHistory.finishedAt)),
    db.select({ finishedAt: cronRunHistory.finishedAt }).from(cronRunHistory).orderBy(desc(cronRunHistory.finishedAt)).limit(1),
    db.select({ n: count() }).from(cronConfig).where(eq(cronConfig.enabled, false)),
  ]);
  return {
    failedLast24h: failedRuns.length,
    failedRuns,
    lastRunAt: lastRunRows[0]?.finishedAt ?? null,
    disabledCount: disabledRows[0]?.n ?? 0,
  };
}

const RESUMABLE = and(eq(accounts.processingPaused, true), isNull(accounts.cancelledAt), isNull(accounts.deletedAt));

async function pausedMerchants(db: Db): Promise<{ count: number; rows: PausedMerchant[] }> {
  const [countRows, rows] = await Promise.all([
    db.select({ n: count() }).from(accounts).where(and(RESUMABLE, NOT_DEMO)),
    db
      .select({ id: accounts.id, name: accounts.name, pauseReason: accounts.pauseReason })
      .from(accounts)
      .where(and(RESUMABLE, NOT_DEMO))
      .orderBy(asc(accounts.name), asc(accounts.id))
      .limit(ATTENTION_LIMIT),
  ]);
  return { count: countRows[0]?.n ?? 0, rows };
}

async function countBillingExempt(db: Db): Promise<number> {
  const rows = await db.select({ n: count() }).from(accounts).where(and(eq(accounts.billingExempt, true), NOT_DEMO));
  return rows[0]?.n ?? 0;
}

async function countNewConnections(db: Db, nowMs: number): Promise<number> {
  const since = new Date(nowMs - NEW_CONNECTION_DAYS * DAY_MS);
  const rows = await db
    .select({ n: count() })
    .from(stripeConnections)
    .innerJoin(accounts, eq(accounts.id, stripeConnections.accountId))
    .where(and(gte(stripeConnections.connectedAt, since), isNull(stripeConnections.disconnectedAt), NOT_DEMO));
  return rows[0]?.n ?? 0;
}

const OPEN_DISPUTE = notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]);

async function openDisputes(
  db: Db,
  nowMs: number,
): Promise<{ count: number; staleCount: number; stale: StaleDispute[] }> {
  const staleBefore = new Date(nowMs - STALE_DISPUTE_DAYS * DAY_MS);
  const STALE = and(OPEN_DISPUTE, isNull(disputes.submittedAt), lt(disputes.createdAt, staleBefore), NOT_DEMO);
  const [countRows, staleCountRows, stale] = await Promise.all([
    db
      .select({ n: count() })
      .from(disputes)
      .innerJoin(accounts, eq(accounts.id, disputes.accountId))
      .where(and(OPEN_DISPUTE, NOT_DEMO)),
    db.select({ n: count() }).from(disputes).innerJoin(accounts, eq(accounts.id, disputes.accountId)).where(STALE),
    db
      .select({
        id: disputes.id,
        accountId: disputes.accountId,
        merchantName: accounts.name,
        amountCents: disputes.amountCents,
        currency: disputes.currency,
        reason: disputes.reason,
        createdAt: disputes.createdAt,
        evidenceDeadline: disputes.evidenceDeadline,
      })
      .from(disputes)
      .innerJoin(accounts, eq(accounts.id, disputes.accountId))
      .where(STALE)
      .orderBy(asc(disputes.createdAt))
      .limit(ATTENTION_LIMIT),
  ]);
  return { count: countRows[0]?.n ?? 0, staleCount: staleCountRows[0]?.n ?? 0, stale };
}

/** billing_invoices.status 'payment_failed' is the charge that failed and has
 *  not since been paid, voided or given up on (app/lib/billing/charge-retry.ts
 *  moves a settled invoice off it), so the row needs a person while it holds. */
async function failedFeeInvoices(db: Db): Promise<{ count: number; rows: FailedFeeInvoice[] }> {
  const failedAt = sql<number>`coalesce(${billingInvoices.lastChargeAttemptAt}, ${billingInvoices.createdAt})`;
  const FAILED = and(eq(billingInvoices.status, "payment_failed"), NOT_DEMO);
  const [countRows, rows] = await Promise.all([
    db
      .select({ n: count() })
      .from(billingInvoices)
      .innerJoin(accounts, eq(accounts.id, billingInvoices.accountId))
      .where(FAILED),
    db
      .select({
        id: billingInvoices.id,
        accountId: billingInvoices.accountId,
        merchantName: accounts.name,
        totalCents: billingInvoices.totalCents,
        currency: billingInvoices.currency,
        chargeAttemptCount: billingInvoices.chargeAttemptCount,
        failedAtMs: failedAt,
      })
      .from(billingInvoices)
      .innerJoin(accounts, eq(accounts.id, billingInvoices.accountId))
      .where(FAILED)
      .orderBy(desc(failedAt))
      .limit(ATTENTION_LIMIT),
  ]);
  return {
    count: countRows[0]?.n ?? 0,
    rows: rows.map(({ failedAtMs, ...row }) => ({ ...row, failedAt: new Date(Number(failedAtMs)) })),
  };
}

async function recoveredThisMonth(db: Db, nowMs: number): Promise<PlatformOverview["recoveredThisMonth"]> {
  const rows = await db
    .select({ currency: recoveredPayments.currency, cents: recoveredPayments.amountCents })
    .from(recoveredPayments)
    .innerJoin(accounts, eq(accounts.id, recoveredPayments.accountId))
    .where(
      and(
        isNull(recoveredPayments.deletedAt),
        gte(recoveredPayments.recoveredAt, new Date(startOfUtcMonthMs(nowMs))),
        NOT_DEMO,
      ),
    );
  return { byCurrency: groupSumByCurrency(rows), paymentCount: rows.length };
}

export async function getPlatformOverview(db: Db, nowMs: number = Date.now()): Promise<PlatformOverview> {
  const [
    merchantCount,
    activeRecoveriesCount,
    mrrByCurrency,
    cronHealthSummary,
    paused,
    billingExemptCount,
    newConnectionsCount,
    disputeSummary,
    feeInvoices,
    recovered,
  ] = await Promise.all([
    countMerchants(db),
    countActiveRecoveries(db),
    mrrUnderManagement(db),
    cronHealth(db),
    pausedMerchants(db),
    countBillingExempt(db),
    countNewConnections(db, nowMs),
    openDisputes(db, nowMs),
    failedFeeInvoices(db),
    recoveredThisMonth(db, nowMs),
  ]);
  return {
    merchantCount,
    activeRecoveriesCount,
    mrrByCurrency,
    cronHealth: cronHealthSummary,
    pausedCount: paused.count,
    billingExemptCount,
    newConnectionsCount,
    openDisputesCount: disputeSummary.count,
    staleDisputesCount: disputeSummary.staleCount,
    failedFeeInvoicesCount: feeInvoices.count,
    recoveredThisMonth: recovered,
    attention: {
      pausedMerchants: paused.rows,
      staleDisputes: disputeSummary.stale,
      failedFeeInvoices: feeInvoices.rows,
    },
  };
}

export interface RecentAdminAction {
  id: string;
  createdAt: Date;
  actorEmail: string;
  /** The action as a sentence (audit-describe.ts), the same words /admin/audit-log uses. */
  action: string;
  target: AuditTarget | null;
}

/** The newest audit rows, described as /admin/audit-log describes them. */
export async function listRecentAdminActions(db: Db): Promise<RecentAdminAction[]> {
  const rows = await listAuditLog(db, RECENT_ACTIONS_LIMIT);
  const lookups = await loadAuditLookups(db, rows);
  return rows.map((e) => ({
    id: e.id,
    createdAt: e.createdAt,
    actorEmail: e.actorEmail,
    action: describeAuditAction(e.action),
    target: auditTarget(e, lookups),
  }));
}
