import { and, desc, eq } from "drizzle-orm";

import { auditRuns, getDb } from "~/db";
import type { Db } from "~/db";

import type { AuditResult, ScopeOutcome } from "./engine";

// Phase (d) of the audit port.

/** A scope's number, or NULL when the scope could not be read. */
function value<T, V>(scope: ScopeOutcome<T>, pick: (data: T) => V): V | null {
  return scope.ok ? pick(scope.data) : null;
}

export interface SaveAuditRunContext {
  accountId: string;
  isAuthenticated: boolean;
  summary: string;
  now: Date;
}

function buildAuditRunRow(result: AuditResult, context: SaveAuditRunContext) {
  return {
    accountId: context.accountId,
    stripeAccountId: result.meta.stripeAccountId,
    runAt: result.meta.ranAt,
    lookbackDays: result.meta.lookbackDays,

    failedInvoicesCount: value(result.failedInvoices, (d) => d.count),
    failedInvoicesCents: value(result.failedInvoices, (d) => d.totalCents),
    declineBreakdown: value(result.failedInvoices, (d) => d.byCategory),

    expiringCardsCount: value(result.expiringCards, (d) => d.count),
    expiringCardsMrrCents: value(result.expiringCards, (d) => d.mrrAtRiskCents),
    expiresByMonth: value(result.expiringCards, (d) => d.expiresByMonth),

    pastDueSubscriptionsCount: value(result.pastDueSubscriptions, (d) => d.count),
    pastDueSubscriptionsCents: value(result.pastDueSubscriptions, (d) => d.totalCents),

    cardUpdaterEventsInWindow: value(result.cardUpdater, (d) => d.eventsInWindow),
    cardUpdaterExpiredDeclinesInWindow: value(
      result.cardUpdater,
      (d) => d.expiredCardDeclinesInWindow,
    ),
    cardUpdaterAdvisory: value(result.cardUpdater, (d) => d.advisory),

    openDisputesCount: value(result.disputes, (d) => d.open.count),
    openDisputesCents: value(result.disputes, (d) => d.open.totalCents),
    disputesAcceptedCount: value(result.disputes, (d) => d.acceptedWithoutFighting.count),
    disputesAcceptedCents: value(result.disputes, (d) => d.acceptedWithoutFighting.totalCents),
    disputesWon: value(result.disputes, (d) => d.historical.won),
    disputesLost: value(result.disputes, (d) => d.historical.lost),

    mrrCents: value(result.health, (d) => d.mrrCents),
    arrCents: value(result.health, (d) => d.arrCents),
    activeSubscriptionsCount: value(result.health, (d) => d.activeSubscriptionsCount),
    voluntaryChurnRateBps: value(result.health, (d) => d.voluntaryChurnRateBps),
    involuntaryChurnRateBps: value(result.health, (d) => d.involuntaryChurnRateBps),

    // Every money figure per currency. The single-number columns above are the
    // figure in `currency` only (engine.ts).
    moneyByCurrency: {
      failedInvoices: value(result.failedInvoices, (d) => d.totals),
      declineBreakdown: value(result.failedInvoices, (d) => d.byCategoryTotals),
      expiringCardsMrr: value(result.expiringCards, (d) => d.mrrAtRiskTotals),
      pastDueSubscriptions: value(result.pastDueSubscriptions, (d) => d.totals),
      openDisputes: value(result.disputes, (d) => d.open.totals),
      disputesAccepted: value(result.disputes, (d) => d.acceptedWithoutFighting.totals),
      mrr: value(result.health, (d) => d.mrrTotals),
      arr: value(result.health, (d) => d.arrTotals),
    },

    aiSummary: context.summary,
    isAuthenticated: context.isAuthenticated,
    currency: result.meta.currency,
    createdAt: context.now,
  };
}

/**
 * Append one run. Returns its id for phase (e)'s link.
 *
 * A PLAIN INSERT, NOT A MONEY WRITE.
 */
export async function saveAuditRun(
  env: Env,
  result: AuditResult,
  context: SaveAuditRunContext,
): Promise<string> {
  const db = getDb(env);
  const id = crypto.randomUUID();
  await db.insert(auditRuns).values({ id, ...buildAuditRunRow(result, context) });
  return id;
}

export type AuditRunRow = typeof auditRuns.$inferSelect;

/**
 * One stored run, scoped to the account.
 *
 * The id reaches this from a URL on phase (e)'s shareable page, so a run
 * belonging to another merchant must return null rather than another merchant's
 * numbers.
 */
export async function getAuditRun(
  db: Db,
  accountId: string,
  runId: string,
): Promise<AuditRunRow | null> {
  const rows = await db
    .select()
    .from(auditRuns)
    .where(and(eq(auditRuns.id, runId), eq(auditRuns.accountId, accountId)))
    .limit(1);
  return rows[0] ?? null;
}

/** An account's runs, newest first, for phase (e)'s history. */
export async function listAuditRuns(db: Db, accountId: string, limit = 24): Promise<AuditRunRow[]> {
  return db
    .select()
    .from(auditRuns)
    .where(eq(auditRuns.accountId, accountId))
    .orderBy(desc(auditRuns.runAt))
    .limit(limit);
}
