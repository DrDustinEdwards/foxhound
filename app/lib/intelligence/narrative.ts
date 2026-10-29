import { HEALTH_SCORE_AT_RISK_THRESHOLD, INTELLIGENCE_NARRATIVE_TOP_N } from "~/lib/constants";
import { formatMoney } from "~/lib/money-format";

// The Intelligence narrative and per-customer assessments, written from a
// template (Dustin 2026-10-29: "so AI use isnt free for me. so why is this
// product free or why does it use AI, like i cant do both"). Intelligence is
// free, so it makes no model call: the narrative was a Sonnet call that only
// phrased numbers the engine had already computed, every night for every
// account, and the free analytics it competes with (ProfitWell Metrics,
// ChartMogul, Baremetrics, Kirn) are rules-based too. AI stays on the paths
// that earn a fee: recovery emails and dispute evidence.
//
// Every number and customer here is a real value narrativeFactsFor takes from
// what the engine computed from customer_context / mrr_snapshots / risk.ts,
// so the text cannot say anything the facts do not.

interface AtRiskCustomerFact {
  stripeCustomerId: string;
  customerName: string | null;
  healthScore: number;
  mrrContributionCents: number;
  currency: string;
  factorDetails: string[];
}

export interface NarrativeFacts {
  currency: string;
  totalMrrCents: number;
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
  reactivationMrrCents: number;
  mrrAtRiskCents: number;
  atRiskCustomerCount: number;
  /** Already capped to the top-N by the caller (INTELLIGENCE_NARRATIVE_TOP_N). */
  topAtRiskCustomers: AtRiskCustomerFact[];
}

/** True when there is anything real to narrate. A brand-new account with no
 *  MRR and no at-risk customers has nothing to say yet: an honest empty state
 *  (DESIGN.md), not a reason to fabricate a narrative. */
export function hasNarrativeFacts(facts: NarrativeFacts): boolean {
  return facts.totalMrrCents > 0 || facts.topAtRiskCustomers.length > 0;
}

export const NOT_ENOUGH_DATA_NARRATIVE =
  "Not enough data yet for a narrative. Once a full billing cycle has synced, this report will summarize MRR movement and the customers most at risk.";

interface NarrativeCustomerAssessment {
  stripeCustomerId: string;
  assessment: string;
}

export interface NarrativeResult {
  narrative: string;
  customerAssessments: NarrativeCustomerAssessment[];
}

/** Factor details as one sentence: "a; b; c." */
function factorSentence(details: string[]): string {
  const text = details.map((d) => d.replace(/\.$/, "")).join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/** The latest snapshot's movements. Snapshots are daily (intelligence-sync),
 *  so they are the change since the day before, and the sentence says so. */
function movementSentence(facts: NarrativeFacts): string {
  const money = (cents: number) => formatMoney(cents, facts.currency);
  const parts = [
    [facts.newMrrCents, "new"],
    [facts.expansionMrrCents, "expansion"],
    [facts.reactivationMrrCents, "reactivation"],
    [facts.contractionMrrCents, "contraction"],
    [facts.churnMrrCents, "churned"],
  ] as const;
  const moved = parts.filter(([cents]) => cents !== 0).map(([cents, label]) => `${money(cents)} ${label}`);
  if (moved.length === 0) return "No MRR moved since the day before.";
  const net =
    facts.newMrrCents + facts.expansionMrrCents + facts.reactivationMrrCents -
    facts.contractionMrrCents - facts.churnMrrCents;
  const netText = net === 0 ? "no net change" : `a net ${net > 0 ? "gain" : "loss"} of ${money(Math.abs(net))}`;
  return `Since the day before: ${moved.join(", ")}, ${netText}.`;
}

function riskSentence(facts: NarrativeFacts): string {
  if (facts.atRiskCustomerCount === 0) return "No customer is at risk right now.";
  const who = facts.atRiskCustomerCount === 1 ? "1 customer" : `${facts.atRiskCustomerCount} customers`;
  const lowest = facts.topAtRiskCustomers[0];
  const lowestText = lowest
    ? ` The lowest health score is ${lowest.customerName ?? lowest.stripeCustomerId} at ${lowest.healthScore}/100.`
    : "";
  return `${formatMoney(facts.mrrAtRiskCents, facts.currency)} of MRR is at risk across ${who}.${lowestText}`;
}

function assessmentFor(c: AtRiskCustomerFact): string {
  const head = `Health score ${c.healthScore}/100 on ${formatMoney(c.mrrContributionCents, c.currency)} of MRR.`;
  return c.factorDetails.length > 0 ? `${head} ${factorSentence(c.factorDetails)}` : head;
}

/** A scored customer as the narrative needs it: from tonight's scoring run,
 *  or from the scores customer_context holds when a merchant asks for a
 *  report during the day (report-generate.server.ts). */
export interface NarrativeCustomer {
  customerContextId: string;
  stripeCustomerId: string;
  customerName: string | null;
  mrrContributionCents: number;
  score: number;
  factors: readonly { detail: string }[];
}

/** The narrative's facts: the latest MRR snapshot's movements and the at-risk
 *  customers, lowest score first, capped at INTELLIGENCE_NARRATIVE_TOP_N. One
 *  computation for both the nightly run and the dashboard's button. */
export function narrativeFactsFor(input: {
  currency: string;
  mrrLatest: {
    totalMrrCents: number;
    newMrrCents: number;
    expansionMrrCents: number;
    contractionMrrCents: number;
    churnMrrCents: number;
    reactivationMrrCents: number;
  } | null;
  scored: readonly NarrativeCustomer[];
}): NarrativeFacts {
  const { currency, mrrLatest, scored } = input;
  const atRisk = scored
    .filter((c) => c.score < HEALTH_SCORE_AT_RISK_THRESHOLD)
    .sort((a, b) => a.score - b.score);
  const topAtRiskCustomers: AtRiskCustomerFact[] = atRisk.slice(0, INTELLIGENCE_NARRATIVE_TOP_N).map((c) => ({
    stripeCustomerId: c.stripeCustomerId,
    customerName: c.customerName,
    healthScore: c.score,
    mrrContributionCents: c.mrrContributionCents,
    currency,
    factorDetails: c.factors.map((f) => f.detail),
  }));
  return {
    currency,
    totalMrrCents: mrrLatest?.totalMrrCents ?? 0,
    newMrrCents: mrrLatest?.newMrrCents ?? 0,
    expansionMrrCents: mrrLatest?.expansionMrrCents ?? 0,
    contractionMrrCents: mrrLatest?.contractionMrrCents ?? 0,
    churnMrrCents: mrrLatest?.churnMrrCents ?? 0,
    reactivationMrrCents: mrrLatest?.reactivationMrrCents ?? 0,
    mrrAtRiskCents: atRisk.reduce((sum, c) => sum + c.mrrContributionCents, 0),
    atRiskCustomerCount: atRisk.length,
    topAtRiskCustomers,
  };
}

/**
 * The Intelligence narrative + per-customer assessments, nightly or on the
 * dashboard's button. Pure: with no facts it returns the honest
 * not-enough-data message and no assessments.
 */
export function writeIntelligenceNarrative(facts: NarrativeFacts): NarrativeResult {
  if (!hasNarrativeFacts(facts)) {
    return { narrative: NOT_ENOUGH_DATA_NARRATIVE, customerAssessments: [] };
  }
  const narrative = [
    `Total MRR is ${formatMoney(facts.totalMrrCents, facts.currency)}.`,
    movementSentence(facts),
    riskSentence(facts),
  ].join(" ");
  return {
    narrative,
    customerAssessments: facts.topAtRiskCustomers.map((c) => ({
      stripeCustomerId: c.stripeCustomerId,
      assessment: assessmentFor(c),
    })),
  };
}
