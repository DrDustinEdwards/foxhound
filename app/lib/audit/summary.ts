import type { AuditResult, MoneyTotals, ScopeOutcome } from "./engine";
import { moneyInputValue } from "@dustinedwards/site-runtime/money";
import { PLAIN_WRITING_PROMPT } from "~/lib/ai/plain-writing";
import { listText } from "capsomer/behavior/hooks";

// Phase (c) of the audit port.

function amountIn(currency: string): (minor: number) => string {
  const code = currency.toLowerCase();
  if (code === "usd") return (minor) => `$${moneyInputValue(minor, "usd")}`;
  return (minor) => `${moneyInputValue(minor, code)} ${code.toUpperCase()}`;
}

/**
 * A figure's amounts, each in its own currency, joined with "and": never one
 * sum across currencies. A single-currency run reads exactly as before, and no
 * money at all reads as a zero in the run's currency.
 */
function amountsIn(currency: string): (totals: MoneyTotals) => string {
  return (totals) =>
    totals.length === 0
      ? amountIn(currency)(0)
      : listText(totals.map((t) => amountIn(t.currency)(t.cents)));
}

/** A scope's line, or the honest absence. */
function line<T>(scope: ScopeOutcome<T>, render: (data: T) => string): string {
  return scope.ok ? render(scope.data) : "could not be read";
}

/**
 * The summary's sentence plan, in the prompt's order. Exported so the
 * /product/audit page describes the summary the model is asked for, read here
 * rather than retyped. The prompt text is unchanged by it.
 */
export const AUDIT_SUMMARY_STRUCTURE = [
  "The biggest revenue leak with its dollar amount.",
  "What Foxhound fixes automatically today.",
  "One forward-looking risk or opportunity.",
] as const;

export function buildAuditSummaryPrompt(result: AuditResult): string {
  const money = amountsIn(result.meta.currency);
  const failed = line(
    result.failedInvoices,
    (d) => `${money(d.totals)} across ${d.count} invoices`,
  );
  const expiring = line(
    result.expiringCards,
    (d) => `${money(d.mrrAtRiskTotals)} MRR at risk across ${d.count} customers`,
  );
  const pastDue = line(
    result.pastDueSubscriptions,
    (d) => `${money(d.totals)} across ${d.count} subs`,
  );
  const openDisputes = line(
    result.disputes,
    (d) => `${money(d.open.totals)} across ${d.open.count} disputes`,
  );
  const accepted = line(
    result.disputes,
    (d) => `${money(d.acceptedWithoutFighting.totals)} across ${d.acceptedWithoutFighting.count}`,
  );
  const history = line(
    result.disputes,
    (d) => `${d.historical.won} won, ${d.historical.lost} lost`,
  );
  const health = line(
    result.health,
    (d) =>
      `MRR: ${money(d.mrrTotals)}, ARR: ${money(d.arrTotals)}, active subs: ${d.activeSubscriptionsCount}`,
  );
  const churn = line(
    result.health,
    (d) =>
      `Involuntary churn: ${(d.involuntaryChurnRateBps / 100).toFixed(2)}%, voluntary churn: ${(d.voluntaryChurnRateBps / 100).toFixed(2)}%`,
  );
  const cardUpdater = line(
    result.cardUpdater,
    (d) =>
      `${d.eventsInWindow} updates fired across ${d.expiredCardDeclinesInWindow} expired-card declines. Advisory: ${d.advisory ?? "none"}.`,
  );

  return `You are writing a 3-sentence audit summary for a SaaS merchant. Do not use bullet points. Reference specific dollar amounts from the data below. Where a line says it could not be read, say that scope is unavailable rather than reporting a number for it.

${PLAIN_WRITING_PROMPT}

DATA:
Failed invoices (last ${result.meta.lookbackDays} days): ${failed}
Expiring cards in next 30 days: ${expiring}
Past-due subscriptions: ${pastDue}
Open disputes: ${openDisputes}
Disputes accepted without fighting: ${accepted}
Dispute history: ${history}
${health}
${churn}
Card Updater (last 30 days): ${cardUpdater}

STRUCTURE, exactly ${AUDIT_SUMMARY_STRUCTURE.length} sentences:
${AUDIT_SUMMARY_STRUCTURE.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Return only the three sentences. No preamble. No list. No quotes.`;
}

export const AUDIT_SUMMARY_FALLBACK =
  "Your Stripe account has recoverable revenue from failed payments and open disputes. Foxhound handles recovery and dispute evidence for you, and bills only on what it recovers. Connect your account to start recovering what you have already earned.";

export function sanitizeSummary(raw: string): string {
  const EM = String.fromCharCode(0x2014);
  const EN = String.fromCharCode(0x2013);
  return raw.split(EM).join(", ").split(EN).join(", ").trim();
}
