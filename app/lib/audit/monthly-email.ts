// The monthly audit email (monthly.server.ts split): the month-over-month
// comparison and the rendered message. Pure; the cron sends it.

import type { Block } from "capsomer/email";
import type { CurrencyCents } from "~/lib/audit/full-audit.server";
import { formatBps, formatTotals, SCOPE_UNREAD } from "~/lib/audit/render";
import { formatMoney } from "~/lib/money-format";
import type { AuditResult, MoneyTotals, ScopeOutcome } from "./engine";

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
 * repeat it. A currency present in only one of the two snapshots still produces
 * a row (missing side reads 0), so a currency that went to zero is visible as a
 * fall rather than vanishing.
 *
 * A null `prior` is a FIRST RUN and not a zero. The change is null and the email
 * says so rather than printing "+$0".
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

/** Legacy's subject, with the one brand substitution and nothing appended
 *  (E24: Recova's subject carries no month). */
export const MONTHLY_AUDIT_SUBJECT = "Your monthly Foxhound report";

/** Recova sends this from FROM_HELLO, "Recova <hello@...>", and its footer
 *  names "Recova": the platform speaks, never the merchant's sender (E24). */
export const MONTHLY_AUDIT_FROM_NAME = "Foxhound";

/** The email_sends template label for this mail. */
export const MONTHLY_AUDIT_TEMPLATE = "monthly_audit";

/**
 * A figure, or the one sentence every audit surface uses for a scope that could
 * not be read.
 *
 * 362 RULING 2 REACHES THE EMAIL. The engine carries a per-scope status, phase
 * (d) stored it as the NULL and phase (e) rendered it as a sentence; an email
 * that coalesced it back to a zero would tell a merchant they have no open
 * disputes on the strength of a Stripe call that failed. Legacy cannot make this
 * mistake in its email because its engine already zeroed the scope upstream,
 * which is the same lie one layer earlier.
 */
function figure<T>(scope: ScopeOutcome<T>, render: (data: T) => string): string {
  return scope.ok ? render(scope.data) : SCOPE_UNREAD;
}

/** One labelled line, as Recova's label and value spans read: "MRR: $1,000".
 *  Plain strings; Capsomer escapes them once, in both parts. Label and value
 *  rows of its own are capsomer job_d7f02cec277c. */
function row(label: string, value: string): Block {
  return { type: "paragraph", text: `${label}: ${value}` };
}

/**
 * A money row, one line per currency (job_ed1c41e4bd95, approved by Dustin on
 * 2026-10-25). The first currency sits on the labelled row as before; each
 * other currency is its own line straight below it. Recova added them into one
 * number under the first currency's label (RULES.md 3.20). A single-currency
 * account gets the one row it always did. `lead` is what goes before the
 * amount on the labelled row ("3, "), `tail` what follows every amount.
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
  /** The run's summary, model-written or the fallback. Foxhound's AuditResult
   *  carries no `aiSummary` field (legacy's does); phase (c) kept the summary a
   *  separate discriminated outcome so a caller can tell a real one from the
   *  fallback, and the email takes the string the caller resolved. */
  summary: string;
  /** The stored run this email links to. Account-scoped at the reader. */
  runId: string;
  baseUrl: string;
  comparisons: CurrencyComparison[];
}

/**
 * The merged email (E24). Pure, so its content is assertable without sending
 * anything, mirroring `buildFailureAlertEmail` and the digest it replaces.
 *
 * RECOVA'S WORDS, IN RECOVA'S ORDER, ON CAPSOMER'S BLOCKS (Q3). Every label
 * below is Recova's `buildAuditEmailBody` verbatim (blob be1ed2ca, lines 169 to
 * 310), with "Recova" becoming "Foxhound" in the one label that names the
 * product. Its two section labels are muted lines, as Recova's are, not
 * headings (a heading below the mail's one h1 is capsomer job_19bf5c96e33d).
 * Recova's colours on the churn, rate and advisory values are look, which is
 * Capsomer's; the words are unchanged. Recova's `&mdash;` row separators are a
 * comma, as no em dash is ported (ENGINE-AUDIT reversal 54, and E22).
 *
 * Recova shows Open disputes and Disputes accepted without response only when
 * their count is above zero, the win rate only when a dispute was decided, and
 * the Card Updater line only with an advisory. A scope whose Stripe read failed
 * still prints its rows as the unread sentence (362 ruling 2), because hiding
 * them would read as a zero.
 *
 * THE ACTIVITY SECTION IS NOT RECOVA'S. Recova's "What Recova did this month"
 * has four tiles from `fetchActivityStats` (Recovered, Recovery rate, Card
 * alerts sent, Win-backs); this carries the absorbed attributed-recovery line
 * of 362 ruling 3 instead. That has no line in parity/APPROVED-DIFFERENCES.md,
 * so the E24 pull request asks Dustin rather than deciding it here.
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
  // THE ONE PLACE THIS EMAIL KEEPS ITS CENTS, and the split is deliberate.
  // Legacy formats every figure in this email at zero fraction digits, and for
  // the DIAGNOSTIC figures that is right: nobody reconciles an MRR estimate to
  // the penny and the decimals are noise. This line is not a diagnostic. It is
  // the attributed-recovery total that PRICING rev 3 charges 20% of, so a
  // merchant may well tie it to an invoice, and rounding $12.40 to $12 in a
  // number they can be billed against is the wrong kind of tidy. The digest this
  // absorbed used `formatMoney` for exactly this figure and keeps it.
  const addsLines: Block[] = comparisons.length
    ? comparisons.map((c) => {
        const total = formatMoney(c.cents, c.currency);
        const code = c.currency.toUpperCase();
        if (c.changeCents === null) {
          return { type: "paragraph", text: `${total} recovered to date (${code}).` };
        }
        const dir = c.changeCents >= 0 ? "up" : "down";
        const change = formatMoney(Math.abs(c.changeCents), c.currency);
        return { type: "paragraph", text: `${total} recovered to date (${code}), ${dir} ${change} since last month.` };
      })
    : [{ type: "paragraph", text: "No recovered payments are attributed to Foxhound yet." }];

  const disputes = result.disputes;
  const disputeWinRate = disputes.ok
    ? (() => {
        const { won, lost } = disputes.data.historical;
        return won + lost > 0 ? `${Math.round((won / (won + lost)) * 100)}% (${won}W / ${lost}L)` : null;
      })()
    : SCOPE_UNREAD;

  const advisory = result.cardUpdater.ok ? result.cardUpdater.data.advisory : null;
  // Recova's two conditional dispute rows: shown when the count is above zero,
  // and always when the read failed, which says so.
  const openDisputes = !disputes.ok || disputes.data.open.count > 0;
  const acceptedDisputes = !disputes.ok || disputes.data.acceptedWithoutFighting.count > 0;

  const blocks: Block[] = [
    ...(summary ? [{ type: "paragraph", text: summary } as Block] : []),

    { type: "fine", text: "What Foxhound did this month" },
    ...addsLines,

    { type: "fine", text: "Your Stripe health" },
    ...moneyRows("MRR", result.health, (h) => ({ totals: h.mrrTotals }), cur),
    ...moneyRows("ARR", result.health, (h) => ({ totals: h.arrTotals }), cur),
    row("Active subs", figure(result.health, (h) => String(h.activeSubscriptionsCount))),

    ...moneyRows("Failed payments detected", result.failedInvoices, (f) => ({ lead: `${f.count}, `, totals: f.totals }), cur),
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
    row("Voluntary churn", figure(result.health, (h) => formatBps(h.voluntaryChurnRateBps))),
    row("Involuntary churn", figure(result.health, (h) => formatBps(h.involuntaryChurnRateBps))),
    ...(openDisputes
      ? moneyRows("Open disputes", disputes, (d) => ({ lead: `${d.open.count}, `, totals: d.open.totals }), cur)
      : []),
    ...(acceptedDisputes
      ? [row("Disputes accepted without response", figure(disputes, (d) => String(d.acceptedWithoutFighting.count)))]
      : []),
    ...(disputeWinRate === null ? [] : [row("Dispute win rate", disputeWinRate)]),
    ...(advisory ? [row("Card Updater", advisory)] : []),

    { type: "button", label: "View full audit", url: `${baseUrl}/audit/results/${runId}` },
  ];

  return { subject: MONTHLY_AUDIT_SUBJECT, blocks };
}
