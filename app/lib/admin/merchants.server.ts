// /admin/merchants data layer (list + detail, READ only - Pass 1). The
// billing_exempt / processing_paused TOGGLE actions and merchant
// cancel/disconnect are Pass 2 (money-adjacent); this pass only displays the
// current flag values.

import { and, count, desc, eq, isNull } from "drizzle-orm";

import type { Db } from "~/db";
import {
  accountProducts,
  accountSubscriptions,
  accounts,
  billingInvoices,
  disputes,
  failedPayments,
  recoveredPayments,
  stripeConnections,
} from "~/db";

export interface MerchantListRow {
  id: string;
  name: string | null;
  createdAt: Date | null;
  billingExempt: boolean;
  processingPaused: boolean;
  connectionStatus: "connected" | "disconnected" | "never_connected";
  activeRecoveriesCount: number;
}

/** One row per (non-demo) account. Connection status and activity counts are
 *  per-account subqueries; platform scale (~hundreds of accounts pre-launch)
 *  keeps N+1-shaped small queries acceptable, matching the posture the rest
 *  of the admin surface takes (see overview.server.ts). */
export async function listMerchants(db: Db): Promise<MerchantListRow[]> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      createdAt: accounts.createdAt,
      billingExempt: accounts.billingExempt,
      processingPaused: accounts.processingPaused,
    })
    .from(accounts)
    .orderBy(desc(accounts.createdAt));

  const results: MerchantListRow[] = [];
  for (const row of rows) {
    const [activeConnection, anyConnection, activeRecoveries] = await Promise.all([
      db
        .select({ id: stripeConnections.id })
        .from(stripeConnections)
        .where(and(eq(stripeConnections.accountId, row.id), isNull(stripeConnections.disconnectedAt)))
        .limit(1),
      db.select({ id: stripeConnections.id }).from(stripeConnections).where(eq(stripeConnections.accountId, row.id)).limit(1),
      db
        .select({ n: count() })
        .from(failedPayments)
        .where(and(eq(failedPayments.accountId, row.id), eq(failedPayments.status, "active"))),
    ]);

    const connectionStatus: MerchantListRow["connectionStatus"] =
      activeConnection.length > 0 ? "connected" : anyConnection.length > 0 ? "disconnected" : "never_connected";

    results.push({
      ...row,
      connectionStatus,
      activeRecoveriesCount: activeRecoveries[0]?.n ?? 0,
    });
  }
  return results;
}

export interface MerchantDetail {
  account: typeof accounts.$inferSelect;
  connections: Array<typeof stripeConnections.$inferSelect>;
  products: Array<typeof accountProducts.$inferSelect>;
  subscriptions: Array<typeof accountSubscriptions.$inferSelect>;
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

export async function getMerchantDetail(db: Db, accountId: string): Promise<MerchantDetail | null> {
  const accountRows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const account = accountRows[0];
  if (!account) return null;

  const [connections, products, subscriptions, activeCount, recoveredCount, allDisputes, recentInvoices] =
    await Promise.all([
      db.select().from(stripeConnections).where(eq(stripeConnections.accountId, accountId)),
      db.select().from(accountProducts).where(eq(accountProducts.accountId, accountId)),
      db.select().from(accountSubscriptions).where(eq(accountSubscriptions.accountId, accountId)),
      db
        .select({ n: count() })
        .from(failedPayments)
        .where(and(eq(failedPayments.accountId, accountId), eq(failedPayments.status, "active")))
        .then((r) => r[0]?.n ?? 0),
      db
        .select({ n: count() })
        .from(recoveredPayments)
        .where(and(eq(recoveredPayments.accountId, accountId), isNull(recoveredPayments.deletedAt)))
        .then((r) => r[0]?.n ?? 0),
      db.select({ state: disputes.state }).from(disputes).where(eq(disputes.accountId, accountId)),
      db
        .select()
        .from(billingInvoices)
        .where(eq(billingInvoices.accountId, accountId))
        .orderBy(desc(billingInvoices.createdAt))
        .limit(10),
    ]);

  const openStates = new Set<string>(DISPUTE_OPEN_STATES);
  const disputeActivity = {
    openCount: allDisputes.filter((d) => openStates.has(d.state)).length,
    resolvedWonCount: allDisputes.filter((d) => d.state === "resolved_won").length,
    resolvedLostCount: allDisputes.filter((d) => d.state === "resolved_lost").length,
  };

  return {
    account,
    connections,
    products,
    subscriptions,
    recoveryActivity: { activeCount, recoveredCount },
    disputeActivity,
    recentInvoices,
  };
}
