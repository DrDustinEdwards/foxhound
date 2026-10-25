import type { AuditResult, ScopeOutcome } from "./engine";

// Phase (c) of the audit port. Legacy's `generateAiSummary`
// (`lib/audit-engine.ts` blob `040912f8`), split into a PURE prompt builder here
// and the call itself in summary.server.ts.
//
// THE PROMPT IS LEGACY'S, PORTED AS FOUND. It is input to a model, not copy
// Foxhound authors, so it is not rewritten to house style; it carries no wide
// dash to remove, and the one instruction that would have been a removal is
// legacy telling the model not to use them, which is kept.
//
// WHAT IS NOT LEGACY'S: how a scope that could not be read is presented. Legacy
// has no such state, because its scopes degrade to zeroes, so it hands the model
// a 0 for a scope its Stripe call failed on and the model writes about a
// merchant with no open disputes. Foxhound's per-scope status (362 ruling 2)
// reaches the prompt as the words "could not be read", class (c): a model told a
// zero writes a sentence about a zero, and that sentence would be a lie with
// digits in it.

const USD = (cents: number) => (cents / 100).toFixed(2);

/** A scope's line, or the honest absence. */
function line<T>(scope: ScopeOutcome<T>, render: (data: T) => string): string {
  return scope.ok ? render(scope.data) : "could not be read";
}

/**
 * The summary's sentence plan, in the prompt's order. Exported so the
 * /product/audit page describes the summary the model is asked for, read here
 * rather than retyped (RULES.md 2.1). The prompt text is unchanged by it.
 */
export const AUDIT_SUMMARY_STRUCTURE = [
  "The biggest revenue leak with its dollar amount.",
  "What Foxhound fixes automatically today.",
  "One forward-looking risk or opportunity.",
] as const;

/**
 * Legacy's prompt, with legacy's DATA block and legacy's three-sentence
 * structure. Pure: same result, same string.
 */
export function buildAuditSummaryPrompt(result: AuditResult): string {
  const failed = line(
    result.failedInvoices,
    (d) => `$${USD(d.totalCents)} across ${d.count} invoices`,
  );
  const expiring = line(
    result.expiringCards,
    (d) => `$${USD(d.mrrAtRiskCents)} MRR at risk across ${d.count} customers`,
  );
  const pastDue = line(
    result.pastDueSubscriptions,
    (d) => `$${USD(d.totalCents)} across ${d.count} subs`,
  );
  const openDisputes = line(
    result.disputes,
    (d) => `$${USD(d.open.totalCents)} across ${d.open.count} disputes`,
  );
  const accepted = line(
    result.disputes,
    (d) => `$${USD(d.acceptedWithoutFighting.totalCents)} across ${d.acceptedWithoutFighting.count}`,
  );
  const history = line(result.disputes, (d) => `${d.historical.won} won, ${d.historical.lost} lost`);
  const health = line(
    result.health,
    (d) =>
      `MRR: $${USD(d.mrrCents)}, ARR: $${USD(d.arrCents)}, active subs: ${d.activeSubscriptionsCount}`,
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

  return `You are writing a 3-sentence audit summary for a SaaS merchant. Do not use em dashes. Do not use bullet points. Reference specific dollar amounts from the data below. Where a line says it could not be read, say that scope is unavailable rather than reporting a number for it.

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

/**
 * Legacy's fallback, with Foxhound's name and Foxhound's promise.
 *
 * IT IS A STATIC STRING AND THAT IS DELIBERATE ON BOTH SIDES: an audit with no
 * summary reads as broken, and a summary invented from the numbers by template
 * would be a worse lie than a general one. Legacy returns it with no API key and
 * on any throw.
 */
export const AUDIT_SUMMARY_FALLBACK =
  "Your Stripe account has recoverable revenue from failed payments and open disputes. Foxhound handles recovery and dispute evidence for you, and bills only on what it recovers. Connect your account to start recovering what you have already earned.";

/**
 * Legacy strips wide dashes from the model's reply before storing it. Foxhound
 * does the same, and for a stronger reason: the no-em-dash rule is portfolio
 * canon and a model reply is the one string in the repo nobody reviewed.
 *
 * The dashes are built from char codes so this file does not itself carry the
 * characters it removes (332 binding 2).
 */
export function sanitizeSummary(raw: string): string {
  const EM = String.fromCharCode(0x2014);
  const EN = String.fromCharCode(0x2013);
  return raw.split(EM).join(", ").split(EN).join(", ").trim();
}
