// The monthly audit email (monthly.server.ts split): the month-over-month
// comparison and the rendered message. Pure; the cron sends it.

import type { Block } from "capsomer/email";
import type { CurrencyCents } from "~/lib/audit/full-audit.server";
import { formatBps } from "capsomer/behavior/format";
import { formatTotals, SCOPE_UNREAD } from "~/lib/audit/render";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import type { AuditResult, MoneyTotals, ScopeOutcome } from "./engine";
import { percent } from "capsomer/behavior/meter";

export interface CurrencyComparison {
  currency: string;
  /** The cumulative attributed-recovery total, this run. */
  cents: number;
  /** Change since the prior month's snapshot, or null when there is none. */
  changeCents: number | null;
}

/**
 * Compare this run's cumulative snapshot against the previous month's.
 *
 * PER CURRENCY, NEVER SUMMED ACROSS THEM. core.md records cross-currency
 * summing as a live data-correctness defect in Intelligence; this does not
 * repeat it.
 */
export function compareTotals(
  current: CurrencyCents[],
  prior: CurrencyCents[] | null,
): CurrencyComparison[] {
  const priorByCurrency = new Map((prior ?? []).map((c) => [c.currency, c.cents]));
  const currentByCurrency = new Map(current.map((c) => [c.currency, c.cents]));
  const currencies = new Set([...currentByCurrency.keys(), ...priorByCurrency.keys()]);

  return [...currencies].sort().map((currency) => {
    const cents = currentByCurrency.get(currency) ?? 0;
    return {
      currency,
      cents,
      changeCents: prior === null ? null : cents - (priorByCurrency.get(currency) ?? 0),
    };
  });
}

const MONTHLY_AUDIT_SUBJECT = "Your monthly Foxhound report";

export const MONTHLY_AUDIT_FROM_NAME = "Foxhound";

/** The email_sends template label for this mail. */
export const MONTHLY_AUDIT_TEMPLATE = "monthly_audit";

/**
 * A figure, or the one sentence every audit surface uses for a scope that could
 * not be read.
 *
 * The engine carries a per-scope status, phase (d) stored it as the NULL and
 * phase (e) rendered it as a sentence; an email that coalesced it back to a
 * zero would tell a merchant they have no open disputes on the strength of a
 * Stripe call that failed.
 */
function figure<T>(scope: ScopeOutcome<T>, render: (data: T) => string): string {
  return scope.ok ? render(scope.data) : SCOPE_UNREAD;
}

function row(label: string, value: string): Block {
  return { type: "paragraph", text: `${label}: ${value}` };
}

/**
 * A money row, one line per currency. The first currency sits on the labeled
 * row as before; each other currency is its own line straight below it. A
 * single-currency account gets the one row it always did.
 */
function moneyRows<T>(
  label: string,
  scope: ScopeOutcome<T>,
  pick: (data: T) => { lead?: string; totals: MoneyTotals; tail?: string },
  cur: string,
): Block[] {
  if (!scope.ok) return [row(label, SCOPE_UNREAD)];
  const { lead = "", totals, tail = "" } = pick(scope.data);
  const [first, ...rest] = formatTotals(totals, cur);
  return [
    row(label, `${lead}${first}${tail}`),
    ...rest.map((line): Block => ({ type: "paragraph", text: `${line}${tail}` })),
  ];
}

export interface MonthlyAuditEmailInput {
  result: AuditResult;
  /** The run's summary, model-written or the fallback. */
  summary: string;
  /** The stored run this email links to. Account-scoped at the reader. */
  runId: string;
  baseUrl: string;
  comparisons: CurrencyComparison[];
}

/**
 * The merged email. Pure, so its content is assertable without sending
 * anything, mirroring `buildFailureAlertEmail` and the digest it replaces.
 */
export function buildMonthlyAuditEmail(input: MonthlyAuditEmailInput): {
  subject: string;
  blocks: Block[];
} {
  const { result, summary, runId, baseUrl, comparisons } = input;
  const cur = result.meta.currency;

  // The absorbed digest line, with the month-over-month delta the claim table's
  // stored snapshot already makes available.
  //
  // The digest this absorbed used `formatMoney` for exactly this figure and
  // keeps it.
  const addsLines: Block[] = comparisons.length
    ? comparisons.map((c) => {
        const total = formatMoney(c.cents, c.currency);
        const code = c.currency.toUpperCase();
        if (c.changeCents === null) {
          return { type: "paragraph", text: `${total} recovered to date (${code}).` };
        }
        const dir = c.changeCents >= 0 ? "up" : "down";
        const change = formatMoney(Math.abs(c.changeCents), c.currency);
        return {
          type: "paragraph",
          text: `${total} recovered to date (${code}), ${dir} ${change} since last month.`,
        };
      })
    : [{ type: "paragraph", text: "No recovered payments are attributed to Foxhound yet." }];

  const disputes = result.disputes;
  const disputeWinRate = disputes.ok
    ? (() => {
        const { won, lost } = disputes.data.historical;
        return won + lost > 0 ? `${percent(won, won + lost)}% (${won}W / ${lost}L)` : null;
      })()
    : SCOPE_UNREAD;

  const advisory = result.cardUpdater.ok ? result.cardUpdater.data.advisory : null;
  const openDisputes = !disputes.ok || disputes.data.open.count > 0;
  const acceptedDisputes = !disputes.ok || disputes.data.acceptedWithoutFighting.count > 0;

  const blocks: Block[] = [
    ...(summary ? [{ type: "paragraph", text: summary } as Block] : []),

    { type: "fine", text: "What Foxhound did this month" },
    ...addsLines,

    { type: "fine", text: "Your Stripe health" },
    ...moneyRows("MRR", result.health, (h) => ({ totals: h.mrrTotals }), cur),
    ...moneyRows("ARR", result.health, (h) => ({ totals: h.arrTotals }), cur),
    row(
      "Active subs",
      figure(result.health, (h) => String(h.activeSubscriptionsCount)),
    ),

    ...moneyRows(
      "Failed payments detected",
      result.failedInvoices,
      (f) => ({ lead: `${f.count}, `, totals: f.totals }),
      cur,
    ),
    ...moneyRows(
      "Expiring cards",
      result.expiringCards,
      (e) => ({ lead: `${e.count}, `, totals: e.mrrAtRiskTotals, tail: " MRR at risk" }),
      cur,
    ),
    ...moneyRows(
      "Past-due subscriptions",
      result.pastDueSubscriptions,
      (p) => ({ lead: `${p.count}, `, totals: p.totals }),
      cur,
    ),
    row(
      "Voluntary churn",
      figure(result.health, (h) => formatBps(h.voluntaryChurnRateBps, { digits: 1 })),
    ),
    row(
      "Involuntary churn",
      figure(result.health, (h) => formatBps(h.involuntaryChurnRateBps, { digits: 1 })),
    ),
    ...(openDisputes
      ? moneyRows(
          "Open disputes",
          disputes,
          (d) => ({ lead: `${d.open.count}, `, totals: d.open.totals }),
          cur,
        )
      : []),
    ...(acceptedDisputes
      ? [
          row(
            "Disputes accepted without response",
            figure(disputes, (d) => String(d.acceptedWithoutFighting.count)),
          ),
        ]
      : []),
    ...(disputeWinRate === null ? [] : [row("Dispute win rate", disputeWinRate)]),
    ...(advisory ? [row("Card Updater", advisory)] : []),

    { type: "button", label: "View full audit", url: `${baseUrl}/audit/results/${runId}` },
  ];

  return { subject: MONTHLY_AUDIT_SUBJECT, blocks };
}
