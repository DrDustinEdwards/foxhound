import type { AuditResult, ScopeOutcome } from "./engine";

import type { AuditRunRow } from "./persist.server";

// Reading a STORED run back for the surfaces. Phase (e).
//
// THE WHOLE POINT OF THIS MODULE IS THE NULL. Legacy's stored-run page maps
// every column with `?? 0`, so an audit whose disputes call failed renders as a
// merchant with no open disputes, and nobody can tell. 362 ruling 2 and 364's
// NULL-as-status exist to stop that, and they only hold if the RENDER honours
// them too: a value that was never read comes back as `null` here and every
// consumer must say so rather than print a figure.
//
// So the shape below is deliberately not "numbers with defaults". It is
// `number | null` all the way to the component, and the component decides how to
// say "could not be read".

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
    totalCents: number;
    byCategory: Record<string, number>;
  } | null;
  expiringCards: {
    count: number;
    mrrAtRiskCents: number;
    expiresByMonth: Record<string, number>;
  } | null;
  pastDueSubscriptions: { count: number; totalCents: number } | null;
  cardUpdater: {
    eventsInWindow: number;
    expiredCardDeclinesInWindow: number;
    advisory: string | null;
  } | null;
  disputes: {
    open: { count: number; totalCents: number };
    acceptedWithoutFighting: { count: number; totalCents: number };
    historical: { won: number; lost: number };
  } | null;
  health: {
    mrrCents: number;
    arrCents: number;
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
  return {
    runAt: result.meta.ranAt,
    lookbackDays: result.meta.lookbackDays,
    currency: result.meta.currency,
    summary,
    failedInvoices: live(result.failedInvoices),
    expiringCards: live(result.expiringCards),
    pastDueSubscriptions: live(result.pastDueSubscriptions),
    cardUpdater:
      cardUpdater === null
        ? null
        : {
            eventsInWindow: cardUpdater.eventsInWindow,
            expiredCardDeclinesInWindow: cardUpdater.expiredCardDeclinesInWindow,
            advisory: cardUpdater.advisory,
          },
    disputes: live(result.disputes),
    health: live(result.health),
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
  return {
    id: row.id,
    runAt: row.runAt,
    lookbackDays: row.lookbackDays,
    currency: row.currency ?? "usd",
    summary: row.aiSummary,

    failedInvoices:
      row.failedInvoicesCount === null
        ? null
        : {
            count: row.failedInvoicesCount,
            totalCents: row.failedInvoicesCents ?? 0,
            byCategory: numberMap(row.declineBreakdown),
          },

    expiringCards:
      row.expiringCardsCount === null
        ? null
        : {
            count: row.expiringCardsCount,
            mrrAtRiskCents: row.expiringCardsMrrCents ?? 0,
            expiresByMonth: numberMap(row.expiresByMonth),
          },

    pastDueSubscriptions:
      row.pastDueSubscriptionsCount === null
        ? null
        : {
            count: row.pastDueSubscriptionsCount,
            totalCents: row.pastDueSubscriptionsCents ?? 0,
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
            open: { count: row.openDisputesCount, totalCents: row.openDisputesCents ?? 0 },
            acceptedWithoutFighting: {
              count: row.disputesAcceptedCount ?? 0,
              totalCents: row.disputesAcceptedCents ?? 0,
            },
            historical: { won: row.disputesWon ?? 0, lost: row.disputesLost ?? 0 },
          },

    health:
      row.mrrCents === null
        ? null
        : {
            mrrCents: row.mrrCents,
            arrCents: row.arrCents ?? 0,
            activeSubscriptionsCount: row.activeSubscriptionsCount ?? 0,
            voluntaryChurnRateBps: row.voluntaryChurnRateBps ?? 0,
            involuntaryChurnRateBps: row.involuntaryChurnRateBps ?? 0,
          },
  };
}

/** The one sentence every surface uses for a scope that was not read. */
export const SCOPE_UNREAD = "Could not be read on this run.";

/** Cents to a display string in the run's currency. */
export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Basis points to a percentage, at legacy's one decimal. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}
