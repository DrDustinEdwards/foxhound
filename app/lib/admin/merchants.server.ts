// /admin/merchants data layer (read-only): list + figures + detail. The
// billing_exempt / processing_paused writes are in merchant-controls.server.ts,
// cancel/disconnect in merchant-cancel.server.ts, and adjustment creation in
// app/lib/billing/adjustment.ts (it flows through the billing ledger).

import { and, asc, count, desc, eq, gte, isNull, ne, notLike, sql } from "drizzle-orm";
import {
  type Db,
  accountMembers,
  accounts,
  billingInvoices,
  billingLineItems,
  disputes,
  failedPayments,
  recoveredPayments,
  stripeConnections,
  user,
} from "~/db";
import { countRows } from "~/db/scope";
import { countActiveRecoveries, mrrUnderManagement } from "~/lib/admin/overview.server";
import { MEMBER_ROLE, MEMBER_STATUS } from "~/lib/auth/roles";
import { startOfUtcMonthMs } from "~/lib/billing/preview.server";
import { groupSumByCurrency, type CurrencyAmount } from "~/lib/money/totals";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { percent } from "capsomer/behavior/meter";

export interface MerchantListRow {
  id: string;
  name: string | null;
  createdAt: Date | null;
  billingExempt: boolean;
  processingPaused: boolean;
  cancelledAt: Date | null;
  connectionStatus: "connected" | "disconnected" | "never_connected";
  activeRecoveriesCount: number;
}

export interface AdminMerchantRow extends MerchantListRow {
  /** PAUSE_REASON_BRAKE or PAUSE_REASON_MANUAL while paused (brake.ts). */
  pauseReason: string | null;
  ownerEmail: string | null;
  /**
   * The live connection's Stripe account: the live primary, else the oldest
   * live one. A disconnected primary stops counting as the primary one
   * (APPROVED-DIFFERENCES, 2026-09-19). Null with no live connection.
   */
  stripeUserId: string | null;
  /** That connection's last webhook. */
  lastWebhookAt: Date | null;
  recoveryRatePct: number | null;
  /** Everything recovered for this merchant, per currency. */
  recovered: CurrencyAmount[];
}

export async function listAdminMerchants(db: Db): Promise<AdminMerchantRow[]> {
  const [rows, owners, connections, activeCounts, failedCounts, recoveredRows] = await Promise.all([
    db
      .select({
        id: accounts.id,
        name: accounts.name,
        createdAt: accounts.createdAt,
        billingExempt: accounts.billingExempt,
        processingPaused: accounts.processingPaused,
        pauseReason: accounts.pauseReason,
        cancelledAt: accounts.cancelledAt,
      })
      .from(accounts)
      .orderBy(desc(accounts.createdAt)),
    db
      .select({ accountId: accountMembers.accountId, email: user.email })
      .from(accountMembers)
      .innerJoin(user, eq(user.id, accountMembers.userId))
      .where(
        and(
          eq(accountMembers.role, MEMBER_ROLE.OWNER),
          eq(accountMembers.status, MEMBER_STATUS.ACTIVE),
        ),
      )
      .orderBy(asc(accountMembers.createdAt)),
    db
      .select({
        accountId: stripeConnections.accountId,
        stripeUserId: stripeConnections.stripeUserId,
        isPrimary: stripeConnections.isPrimary,
        disconnectedAt: stripeConnections.disconnectedAt,
        lastWebhookAt: stripeConnections.lastWebhookAt,
      })
      .from(stripeConnections)
      .orderBy(asc(stripeConnections.connectedAt), asc(stripeConnections.createdAt)),
    db
      .select({ accountId: failedPayments.accountId, n: count() })
      .from(failedPayments)
      .where(and(eq(failedPayments.status, "active"), isNull(failedPayments.deletedAt)))
      .groupBy(failedPayments.accountId),
    db
      .select({ accountId: failedPayments.accountId, n: count() })
      .from(failedPayments)
      .where(isNull(failedPayments.deletedAt))
      .groupBy(failedPayments.accountId),
    db
      .select({
        accountId: recoveredPayments.accountId,
        currency: recoveredPayments.currency,
        cents: sql<number>`coalesce(sum(${recoveredPayments.amountCents}), 0)`,
        n: count(),
      })
      .from(recoveredPayments)
      .where(isNull(recoveredPayments.deletedAt))
      .groupBy(recoveredPayments.accountId, recoveredPayments.currency),
  ]);

  const ownerByAccount = new Map<string, string>();
  for (const o of owners)
    if (!ownerByAccount.has(o.accountId)) ownerByAccount.set(o.accountId, o.email);

  const connectionsByAccount = new Map<string, typeof connections>();
  for (const c of connections) {
    const list = connectionsByAccount.get(c.accountId) ?? [];
    list.push(c);
    connectionsByAccount.set(c.accountId, list);
  }

  const activeByAccount = new Map(activeCounts.map((r) => [r.accountId, r.n]));
  const failedByAccount = new Map(failedCounts.map((r) => [r.accountId, r.n]));
  const recoveredByAccount = new Map<
    string,
    { n: number; amounts: Array<{ currency: string; cents: number }> }
  >();
  for (const r of recoveredRows) {
    const entry = recoveredByAccount.get(r.accountId) ?? { n: 0, amounts: [] };
    entry.n += r.n;
    entry.amounts.push({ currency: r.currency, cents: Number(r.cents) });
    recoveredByAccount.set(r.accountId, entry);
  }

  return rows.map((row) => {
    const own = connectionsByAccount.get(row.id) ?? [];
    const live = own.filter((c) => c.disconnectedAt === null);
    const shown = live.find((c) => c.isPrimary) ?? live[0] ?? null;
    const failedCount = failedByAccount.get(row.id) ?? 0;
    const recovered = recoveredByAccount.get(row.id);
    return {
      ...row,
      connectionStatus:
        live.length > 0 ? "connected" : own.length > 0 ? "disconnected" : "never_connected",
      activeRecoveriesCount: activeByAccount.get(row.id) ?? 0,
      ownerEmail: ownerByAccount.get(row.id) ?? null,
      stripeUserId: shown?.stripeUserId ?? null,
      lastWebhookAt: shown?.lastWebhookAt ?? null,
      recoveryRatePct: failedCount > 0 ? percent(recovered?.n ?? 0, failedCount) : null,
      recovered: groupSumByCurrency(recovered?.amounts ?? []),
    };
  });
}

/**
 * The admin API's merchants list (GET /merchants): the same rows, with the
 * fields it has always returned and no more.
 */
export async function listMerchants(db: Db): Promise<MerchantListRow[]> {
  const rows = await listAdminMerchants(db);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    billingExempt: r.billingExempt,
    processingPaused: r.processingPaused,
    cancelledAt: r.cancelledAt,
    connectionStatus: r.connectionStatus,
    activeRecoveriesCount: r.activeRecoveriesCount,
  }));
}

export interface MerchantFigures {
  /** Accounts, demo ones not counted: the denominator for connectedCount. */
  merchantCount: number;
  mrrByCurrency: Array<{ currency: string; totalCents: number; accountCount: number }>;
  connectedCount: number;
  totalRecovered: CurrencyAmount[];
  recoveryFeesThisMonth: CurrencyAmount[];
  paymentsInQueue: number;
}

const NOT_DEMO = notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`);

export async function getMerchantFigures(db: Db, nowMs: number): Promise<MerchantFigures> {
  const monthStart = new Date(startOfUtcMonthMs(nowMs));
  const [merchantCount, mrrByCurrency, connectedRows, recoveredRows, feeRows, paymentsInQueue] =
    await Promise.all([
      countRows(db, accounts, NOT_DEMO),
      mrrUnderManagement(db),
      db
        .select({ n: sql<number>`count(distinct ${stripeConnections.accountId})` })
        .from(stripeConnections)
        .innerJoin(accounts, eq(accounts.id, stripeConnections.accountId))
        .where(and(isNull(stripeConnections.disconnectedAt), NOT_DEMO)),
      db
        .select({
          currency: recoveredPayments.currency,
          cents: sql<number>`coalesce(sum(${recoveredPayments.amountCents}), 0)`,
        })
        .from(recoveredPayments)
        .innerJoin(accounts, eq(accounts.id, recoveredPayments.accountId))
        .where(and(isNull(recoveredPayments.deletedAt), NOT_DEMO))
        .groupBy(recoveredPayments.currency),
      db
        .select({
          currency: billingLineItems.currency,
          cents: sql<number>`coalesce(sum(coalesce(${billingLineItems.feeCents}, ${billingLineItems.amountCents})), 0)`,
        })
        .from(billingLineItems)
        .innerJoin(billingInvoices, eq(billingInvoices.id, billingLineItems.invoiceId))
        .innerJoin(accounts, eq(accounts.id, billingLineItems.accountId))
        .where(
          and(
            eq(billingLineItems.type, "recovery_fee"),
            gte(billingInvoices.createdAt, monthStart),
            ne(billingInvoices.status, "void"),
            NOT_DEMO,
          ),
        )
        .groupBy(billingLineItems.currency),
      // The Overview's own count, so "Payments in queue" and "Active
      // recoveries" can never disagree.
      countActiveRecoveries(db),
    ]);
  const money = (rows: Array<{ currency: string; cents: number }>) =>
    groupSumByCurrency(rows.map((r) => ({ currency: r.currency, cents: Number(r.cents) }))).filter(
      (m) => m.cents !== 0,
    );
  return {
    merchantCount,
    mrrByCurrency,
    connectedCount: Number(connectedRows[0]?.n ?? 0),
    totalRecovered: money(recoveredRows),
    recoveryFeesThisMonth: money(feeRows),
    paymentsInQueue,
  };
}

export interface MerchantDetail {
  account: typeof accounts.$inferSelect;
  connections: Array<typeof stripeConnections.$inferSelect>;
  recoveryActivity: {
    activeCount: number;
    recoveredCount: number;
  };
  disputeActivity: {
    openCount: number;
    resolvedWonCount: number;
    resolvedLostCount: number;
  };
  recentInvoices: Array<typeof billingInvoices.$inferSelect>;
}

const DISPUTE_OPEN_STATES = ["draft", "pending_review", "approved", "submitted"] as const;

/**
 * The currencies an admin adjustment may be in for this account: its home
 * currency and every currency it has a fee invoice in, lowercase. An adjustment
 * lands on an invoice in its currency, so any other is a typo, and the amount
 * is read in that currency's minor units.
 */
export async function listAdjustmentCurrencies(db: Db, accountId: string): Promise<Set<string>> {
  const [account, invoices] = await Promise.all([
    db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)),
    db
      .selectDistinct({ currency: billingInvoices.currency })
      .from(billingInvoices)
      .where(eq(billingInvoices.accountId, accountId)),
  ]);
  const found = [account[0]?.currency, ...invoices.map((r) => r.currency)].flatMap((c) =>
    c ? [c.toLowerCase()] : [],
  );
  // No home currency and never billed: the form's own default.
  return new Set(found.length > 0 ? found : ["usd"]);
}

export async function getMerchantDetail(db: Db, accountId: string): Promise<MerchantDetail | null> {
  const accountRows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const account = accountRows[0];
  if (!account) return null;

  const [connections, activeCount, recoveredCount, allDisputes, recentInvoices] = await Promise.all(
    [
      db.select().from(stripeConnections).where(eq(stripeConnections.accountId, accountId)),
      countRows(
        db,
        failedPayments,
        and(eq(failedPayments.accountId, accountId), eq(failedPayments.status, "active")),
      ),
      countRows(
        db,
        recoveredPayments,
        and(eq(recoveredPayments.accountId, accountId), isNull(recoveredPayments.deletedAt)),
      ),
      db.select({ state: disputes.state }).from(disputes).where(eq(disputes.accountId, accountId)),
      db
        .select()
        .from(billingInvoices)
        .where(eq(billingInvoices.accountId, accountId))
        .orderBy(desc(billingInvoices.createdAt))
        .limit(10),
    ],
  );

  const openStates = new Set<string>(DISPUTE_OPEN_STATES);
  const disputeActivity = {
    openCount: allDisputes.filter((d) => openStates.has(d.state)).length,
    resolvedWonCount: allDisputes.filter((d) => d.state === "resolved_won").length,
    resolvedLostCount: allDisputes.filter((d) => d.state === "resolved_lost").length,
  };

  return {
    account,
    connections,
    recoveryActivity: { activeCount, recoveredCount },
    disputeActivity,
    recentInvoices,
  };
}

/**
 * What the Merchants page's action needs to know before it writes: that the
 * account exists, its name for the result, and whether the brake owns its pause
 * (a resume of that has no Undo). Null when there is no such account.
 */
export async function getMerchantActionTarget(
  db: Db,
  accountId: string,
): Promise<{
  id: string;
  name: string | null;
  billingExempt: boolean;
  processingPaused: boolean;
  pauseReason: string | null;
  cancelledAt: Date | null;
} | null> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      billingExempt: accounts.billingExempt,
      processingPaused: accounts.processingPaused,
      pauseReason: accounts.pauseReason,
      cancelledAt: accounts.cancelledAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return rows[0] ?? null;
}
