import type { AuditResult, MoneyTotals, ScopeOutcome } from "./engine";

import type { AuditRunRow } from "./persist.server";
import { formatMoneyShort } from "~/lib/money-format";

// Reading a STORED run back for the surfaces. Phase (e).
//
// THE WHOLE POINT OF THIS MODULE IS THE NULL. Legacy's stored-run page maps
// every column with `?? 0`, so an audit whose disputes call failed renders as a
// merchant with no open disputes, and nobody can tell. 362 ruling 2 and 364's
// NULL-as-status exist to stop that, and they only hold if the RENDER honors
// them too: a value that was never read comes back as `null` here and every
// consumer must say so rather than print a figure.
//
// So the shape below is deliberately not "numbers with defaults". It is
// `number | null` all the way to the component, and the component decides how to
// say "could not be read".
//
// MONEY IS PER CURRENCY (job_ed1c41e4bd95): each figure is its totals, one
// entry per currency in currency-code order (RULES.md 3.20), and the
// sections show one line per currency. A run stored before money_by_currency
// existed has one total in its one currency, and shows it as it always did.

export interface StoredScope<T> {
  /** Null when the scope could not be read on the run that produced this row. */
  data: T | null;
}

/**
 * What a surface renders, from EITHER source.
 *
 * TWO PRODUCERS, ONE SHAPE, ADDED IN PHASE (f). `toStoredAuditRun` maps a stored
 * row; `toAuditRunView` maps an in-memory result the engine just produced for
 * the live anonymous page. Legacy shares its four section components between its
 * stored-run page and its live results page the same way, and the alternative
 * here was a second copy of every section rendering a second shape, which is how
 * the `?? 0` defect ends up fixed in one of them and not the other.
 *
 * NO `id`. A live run has none: it may never be stored at all. The id lives on
 * StoredAuditRun below, where it is real, and no section component reads it.
 */
export interface AuditRunView {
  runAt: Date;
  lookbackDays: number;
  currency: string;
  summary: string | null;
  failedInvoices: {
    count: number;
    totals: MoneyTotals;
    byCategory: Record<string, MoneyTotals>;
  } | null;
  expiringCards: {
    count: number;
    mrrAtRisk: MoneyTotals;
    expiresByMonth: Record<string, number>;
  } | null;
  pastDueSubscriptions: { count: number; totals: MoneyTotals } | null;
  cardUpdater: {
    eventsInWindow: number;
    expiredCardDeclinesInWindow: number;
    advisory: string | null;
  } | null;
  disputes: {
    open: { count: number; totals: MoneyTotals };
    acceptedWithoutFighting: { count: number; totals: MoneyTotals };
    historical: { won: number; lost: number };
  } | null;
  health: {
    mrr: MoneyTotals;
    arr: MoneyTotals;
    activeSubscriptionsCount: number;
    voluntaryChurnRateBps: number;
    involuntaryChurnRateBps: number;
  } | null;
}

/** A run that was stored, and therefore has an id to link to. */
export interface StoredAuditRun extends AuditRunView {
  id: string;
}

/** A scope's data, or null when the scope could not be read. The in-memory twin
 *  of the NULL column, so both producers say "unknown" the same way. */
function live<T>(scope: ScopeOutcome<T>): T | null {
  return scope.ok ? scope.data : null;
}

/**
 * Map an in-memory result to the render shape, for the live page.
 *
 * THE DISCRIMINATED OUTCOME COLLAPSES TO null HERE AND NOWHERE EARLIER. Between
 * the engine and this line the reason a scope failed is still carried; the
 * surfaces do not print it, because "the disputes call failed with a 401" is our
 * problem and "could not be read" is the merchant's. The reason stays available
 * to a caller that wants to log it.
 */
export function toAuditRunView(result: AuditResult, summary: string | null): AuditRunView {
  const cardUpdater = live(result.cardUpdater);
  const failed = live(result.failedInvoices);
  const expiring = live(result.expiringCards);
  const pastDue = live(result.pastDueSubscriptions);
  const disputes = live(result.disputes);
  const health = live(result.health);
  return {
    runAt: result.meta.ranAt,
    lookbackDays: result.meta.lookbackDays,
    currency: result.meta.currency,
    summary,
    failedInvoices:
      failed === null ? null : { count: failed.count, totals: failed.totals, byCategory: failed.byCategoryTotals },
    expiringCards:
      expiring === null
        ? null
        : { count: expiring.count, mrrAtRisk: expiring.mrrAtRiskTotals, expiresByMonth: expiring.expiresByMonth },
    pastDueSubscriptions: pastDue === null ? null : { count: pastDue.count, totals: pastDue.totals },
    cardUpdater:
      cardUpdater === null
        ? null
        : {
            eventsInWindow: cardUpdater.eventsInWindow,
            expiredCardDeclinesInWindow: cardUpdater.expiredCardDeclinesInWindow,
            advisory: cardUpdater.advisory,
          },
    disputes:
      disputes === null
        ? null
        : {
            open: { count: disputes.open.count, totals: disputes.open.totals },
            acceptedWithoutFighting: {
              count: disputes.acceptedWithoutFighting.count,
              totals: disputes.acceptedWithoutFighting.totals,
            },
            historical: disputes.historical,
          },
    health:
      health === null
        ? null
        : {
            mrr: health.mrrTotals,
            arr: health.arrTotals,
            activeSubscriptionsCount: health.activeSubscriptionsCount,
            voluntaryChurnRateBps: health.voluntaryChurnRateBps,
            involuntaryChurnRateBps: health.involuntaryChurnRateBps,
          },
  };
}

/** A record of numbers from stored JSON, dropping anything that is not one. */
function numberMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

/** Totals from stored JSON, dropping any entry that is not one. */
function totalsFrom(raw: unknown): MoneyTotals | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (t): t is { currency: string; cents: number } =>
      !!t && typeof t === "object" && typeof t.currency === "string" && typeof t.cents === "number",
  );
}

/** A stored figure per currency: the money_by_currency entry when the run has
 *  one, else the run's one total in its one currency, as it was stored. */
function storedTotals(perCurrency: unknown, cents: number | null, currency: string): MoneyTotals {
  return totalsFrom(perCurrency) ?? (cents ? [{ currency, cents }] : []);
}

/**
 * Map a stored row to the render shape.
 *
 * A SCOPE IS PRESENT ONLY IF ITS ANCHOR COLUMN IS. Each scope picks one column
 * that is NULL exactly when the scope failed and never otherwise, and the whole
 * scope stands or falls on it. The Card Updater's anchor is its EVENT COUNT
 * rather than its advisory, because the advisory is legitimately null when no
 * advisory fires (364 binding 20).
 */
export function toStoredAuditRun(row: AuditRunRow): StoredAuditRun {
  const currency = row.currency ?? "usd";
  const money = row.moneyByCurrency;
  const breakdown = money?.declineBreakdown ?? null;
  return {
    id: row.id,
    runAt: row.runAt,
    lookbackDays: row.lookbackDays,
    currency,
    summary: row.aiSummary,

    failedInvoices:
      row.failedInvoicesCount === null
        ? null
        : {
            count: row.failedInvoicesCount,
            totals: storedTotals(money?.failedInvoices, row.failedInvoicesCents, currency),
            byCategory: Object.fromEntries(
              Object.entries(numberMap(row.declineBreakdown)).map(([key, cents]) => [
                key,
                storedTotals(breakdown?.[key], cents, currency),
              ]),
            ),
          },

    expiringCards:
      row.expiringCardsCount === null
        ? null
        : {
            count: row.expiringCardsCount,
            mrrAtRisk: storedTotals(money?.expiringCardsMrr, row.expiringCardsMrrCents, currency),
            expiresByMonth: numberMap(row.expiresByMonth),
          },

    pastDueSubscriptions:
      row.pastDueSubscriptionsCount === null
        ? null
        : {
            count: row.pastDueSubscriptionsCount,
            totals: storedTotals(money?.pastDueSubscriptions, row.pastDueSubscriptionsCents, currency),
          },

    cardUpdater:
      row.cardUpdaterEventsInWindow === null
        ? null
        : {
            eventsInWindow: row.cardUpdaterEventsInWindow,
            expiredCardDeclinesInWindow: row.cardUpdaterExpiredDeclinesInWindow ?? 0,
            advisory: row.cardUpdaterAdvisory,
          },

    disputes:
      row.openDisputesCount === null
        ? null
        : {
            open: {
              count: row.openDisputesCount,
              totals: storedTotals(money?.openDisputes, row.openDisputesCents, currency),
            },
            acceptedWithoutFighting: {
              count: row.disputesAcceptedCount ?? 0,
              totals: storedTotals(money?.disputesAccepted, row.disputesAcceptedCents, currency),
            },
            historical: { won: row.disputesWon ?? 0, lost: row.disputesLost ?? 0 },
          },

    health:
      row.mrrCents === null
        ? null
        : {
            mrr: storedTotals(money?.mrr, row.mrrCents, currency),
            arr: storedTotals(money?.arr, row.arrCents, currency),
            activeSubscriptionsCount: row.activeSubscriptionsCount ?? 0,
            voluntaryChurnRateBps: row.voluntaryChurnRateBps ?? 0,
            involuntaryChurnRateBps: row.involuntaryChurnRateBps ?? 0,
          },
  };
}

/** The one sentence every surface uses for a scope that was not read. */
export const SCOPE_UNREAD = "Could not be read on this run.";

/** Minor units to a whole-unit display string in the run's currency. */
export function formatCents(cents: number, currency: string): string {
  return formatMoneyShort(cents, currency);
}

/**
 * A figure's display lines, one per currency in its totals' order. No money
 * at all reads as a zero in the run's currency, which is what a
 * single-currency run always showed.
 */
export function formatTotals(totals: readonly { currency: string; cents: number }[], runCurrency: string): string[] {
  if (totals.length === 0) return [formatCents(0, runCurrency)];
  return totals.map((t) => formatCents(t.cents, t.currency));
}

/** Whether a figure carries any money above zero. */
export function anyAbove(totals: readonly { cents: number }[]): boolean {
  return totals.some((t) => t.cents > 0);
}

/** Basis points to a percentage, at legacy's one decimal. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}
