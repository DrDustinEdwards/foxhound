// Platform-wide health summary for /admin (overview). Every query here is
// GLOBAL (no account_id scope, this is the operator surface, not a tenant
// surface) and excludes demo accounts (DEMO_ACCOUNT_ID_PREFIX), matching the
// accountBillingEligibleCondition demo-exclusion convention in app/db/billable.ts.

import { and, count, desc, eq, notLike, sql } from "drizzle-orm";

import type { Db } from "~/db";
import { accounts, cronConfig, cronRunHistory, failedPayments, mrrSnapshots } from "~/db";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";

const NOT_DEMO = notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`);

export interface PlatformOverview {
  merchantCount: number;
  activeRecoveriesCount: number;
  mrrByCurrency: Array<{ currency: string; totalCents: number; accountCount: number }>;
  cronHealth: {
    failedLast24h: number;
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
  const [failedRows, lastRunRows, disabledRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(cronRunHistory)
      .where(and(eq(cronRunHistory.status, "failed"), sql`${cronRunHistory.finishedAt} >= ${since.getTime()}`)),
    db.select({ finishedAt: cronRunHistory.finishedAt }).from(cronRunHistory).orderBy(desc(cronRunHistory.finishedAt)).limit(1),
    db.select({ n: count() }).from(cronConfig).where(eq(cronConfig.enabled, false)),
  ]);
  return {
    failedLast24h: failedRows[0]?.n ?? 0,
    lastRunAt: lastRunRows[0]?.finishedAt ?? null,
    disabledCount: disabledRows[0]?.n ?? 0,
  };
}

export async function getPlatformOverview(db: Db): Promise<PlatformOverview> {
  const [merchantCount, activeRecoveriesCount, mrrByCurrency, cronHealthSummary] = await Promise.all([
    countMerchants(db),
    countActiveRecoveries(db),
    mrrUnderManagement(db),
    cronHealth(db),
  ]);
  return { merchantCount, activeRecoveriesCount, mrrByCurrency, cronHealth: cronHealthSummary };
}
