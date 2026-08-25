import { and, desc, eq } from "drizzle-orm";

import { auditRuns, getDb } from "~/db";
import type { Db } from "~/db";

import type { AuditResult, ScopeOutcome } from "./engine";

// Phase (d) of the audit port. The insert legacy performs, onto the 29 columns
// `audit_runs` already carries.
//
// NO MIGRATION, which the walk found and 363 confirmed: the table was built with
// legacy's full column set and has sat empty since. This is code, not schema.
//
// WHERE THE PER-SCOPE STATUS LIVES, since 362 ruling 2 gave the engine one and
// the table has no column for it: IN THE NULLS. Every scope column is nullable,
// so a scope that was READ stores its number (0 included) and a scope that could
// NOT be read stores NULL. The distinction survives the round trip without a
// column, and the render derives "could not be read" from NULL rather than being
// told separately. The one place NULL would be ambiguous is
// `card_updater_advisory`, which is legitimately NULL when no advisory fires, so
// it is disambiguated by `card_updater_events_in_window`, NULL only on failure.
//
// A SAVE IS HISTORY, NOT A CACHE. Legacy inserts a row per run and renders from
// the in-memory result, never reading the row back on the same request. Foxhound
// keeps that: `saveAuditRun` appends, and `getAuditRun` exists for phase (e)'s
// shareable page, which is legacy's only reader of a stored run.

/** A scope's number, or NULL when the scope could not be read. */
function value<T, V>(scope: ScopeOutcome<T>, pick: (data: T) => V): V | null {
  return scope.ok ? pick(scope.data) : null;
}

export interface SaveAuditRunContext {
  accountId: string;
  /** Legacy's own flag: true for a run saved against a signed-in account. */
  isAuthenticated: boolean;
  summary: string;
  now: Date;
}

/**
 * The row legacy builds, field for field. Pure and exported so a plant can drive
 * the real mapping rather than a reproduction of it (337 binding 4).
 */
export function buildAuditRunRow(result: AuditResult, context: SaveAuditRunContext) {
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

    aiSummary: context.summary,
    isAuthenticated: context.isAuthenticated,
    currency: result.meta.currency,
    createdAt: context.now,
  };
}

/**
 * Append one run. Returns its id for phase (e)'s link.
 *
 * A PLAIN INSERT, NOT A MONEY WRITE. The audit is free under PRICING rev 3: this
 * records no outcome, attributes no recovery and gates no fee, so it fails 333's
 * test for the money DO on every clause.
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
 * ACCOUNT-SCOPED IN THE PREDICATE, not by the caller (352 binding 4). The id
 * reaches this from a URL on phase (e)'s shareable page, so a run belonging to
 * another merchant must return null rather than another merchant's numbers.
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
export async function listAuditRuns(
  db: Db,
  accountId: string,
  limit = 24,
): Promise<AuditRunRow[]> {
  return db
    .select()
    .from(auditRuns)
    .where(eq(auditRuns.accountId, accountId))
    .orderBy(desc(auditRuns.runAt))
    .limit(limit);
}
