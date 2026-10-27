// Recova's recommendation rules, ported as rules onto Foxhound's own inputs
// (job J78, row S20; Dustin 2026-10-25: "Port now, measure, improve later").
//
// Recova is the spec, read whole at these blobs:
//   lib/intelligence/bands.ts      119bec74 (the three bands and their cut points)
//   lib/intelligence/recommend.ts  b753ab76 (the table, the confidence rule, the text)
//   lib/intelligence/schema.ts     8969589a (the band and action names)
//
// Pure: no database, no clock. The inputs are read by recommendations.server.ts
// from Foxhound's tables, and the nightly scoring batch (ai-run.server.ts) stores
// the action in customer_context.recommended_action.
//
// NOTHING ON A MONEY PATH READS THE ACTION. Recova's table only ever produces
// the four actions below. Recova's schema also names winback_priority,
// expansion_outreach and accept_loss_dispute, which no rule produces, so they
// are not ported: a winback_priority writer would move a customer's first
// win-back email from 4 hours to 1 (webhooks/lookups.ts), and Recova never
// actually ran its 48 hour deprioritize delay, which Foxhound does not have.
//
// The rationale is Recova's word for word, except five lines that claimed more
// than the data can show (RULES.md 1.2). Each is marked below with Recova's text.

export type EngagementBand = "green" | "yellow" | "red" | "unknown";
export type RecoveryBand = "green" | "yellow" | "red" | "unknown";
export type ValueBand = "high" | "medium" | "low";
type BandConfidence = "high" | "medium" | "low" | "unknown";
type RecommendationConfidence = "high" | "medium" | "low";

export const RECOMMENDED_ACTIONS = [
  "personal_outreach",
  "continue_automated",
  "continue_automated_priority",
  "continue_automated_deprioritize",
] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

/** The actions that ask the merchant to do something, in Recova's page order.
 *  Recova's list also held the three actions nothing produces (see above). */
export const ACTIONABLE_RECOMMENDATIONS = ["personal_outreach", "continue_automated_priority"] as const;

const DAY_MS = 86_400_000;
const ANNUALIZE_MONTHS = 12;

function nonNeg(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

// ---- the three bands (Recova's bands.ts) ------------------------------------

export interface EngagementInput {
  /** Recovery emails sent to this customer in the last 30 days. */
  sent30d: number;
  /** Tracked opens of those emails in the last 30 days. */
  opened30d: number;
  /** The customer's most recent tracked open, or null. */
  lastOpenAtMs: number | null;
  nowMs: number;
}

export interface EngagementHealth {
  band: EngagementBand;
  confidence: BandConfidence;
  evidence: { emailsSent30d: number; emailsOpened30d: number; lastOpenAtMs: number | null };
}

/** Under 3 sends: unknown. No opens: red. Last open within 14 days: green.
 *  Anything older, or an open with no time: yellow. Recova's boundaries are
 *  inclusive (14 days exactly is green). */
export function engagementBand(input: EngagementInput): EngagementHealth {
  const sent = nonNeg(input.sent30d);
  const opened = nonNeg(input.opened30d);
  const evidence = { emailsSent30d: sent, emailsOpened30d: opened, lastOpenAtMs: input.lastOpenAtMs };
  const confidence: BandConfidence = sent === 0 ? "unknown" : sent <= 2 ? "low" : sent <= 4 ? "medium" : "high";

  if (sent < 3) return { band: "unknown", confidence, evidence };
  if (opened === 0) return { band: "red", confidence, evidence };
  const daysSinceOpen = input.lastOpenAtMs === null ? null : (input.nowMs - input.lastOpenAtMs) / DAY_MS;
  if (daysSinceOpen !== null && daysSinceOpen <= 14) return { band: "green", confidence, evidence };
  return { band: "yellow", confidence, evidence };
}

export interface RecoveryHistory {
  band: RecoveryBand;
  confidence: BandConfidence;
  evidence: { priorFailuresCount: number; priorRecoveriesCount: number; historicalRecoveryRateBps: number | null };
}

/** Under 3 failed payments: unknown. Then recovered / failed: 60% and up
 *  green, 30% and up yellow, below that red. */
export function recoveryHistoryBand(input: { failedPaymentCount: number; recoveredCount: number }): RecoveryHistory {
  const failed = nonNeg(input.failedPaymentCount);
  const recovered = nonNeg(input.recoveredCount);
  const evidence = { priorFailuresCount: failed, priorRecoveriesCount: recovered, historicalRecoveryRateBps: null as number | null };
  if (failed < 3) return { band: "unknown", confidence: "unknown", evidence };

  const rate = recovered / failed;
  evidence.historicalRecoveryRateBps = Math.round(rate * 10_000);
  const confidence: BandConfidence = failed >= 5 ? "high" : "medium";
  if (rate >= 0.6) return { band: "green", confidence, evidence };
  if (rate >= 0.3) return { band: "yellow", confidence, evidence };
  return { band: "red", confidence, evidence };
}

export interface CustomerValue {
  band: ValueBand;
  confidence: RecommendationConfidence;
  evidence: { mrrContributionCents: number; percentileWithinAccount: number };
}

/** The customer's MRR as a percentile of every customer on the account: 75
 *  and up high, 25 and under low, and no MRR at all low. */
export function customerValueBand(input: { mrrContributionCents: number; accountMrrAscending: readonly number[] }): CustomerValue {
  const mrr = nonNeg(input.mrrContributionCents);
  const size = input.accountMrrAscending.length;
  const accountConfidence: RecommendationConfidence = size >= 20 ? "high" : size >= 10 ? "medium" : "low";
  if (mrr === 0) {
    return { band: "low", confidence: "low", evidence: { mrrContributionCents: 0, percentileWithinAccount: 0 } };
  }
  const percentile = percentileRank(mrr, input.accountMrrAscending);
  const band: ValueBand = percentile >= 75 ? "high" : percentile <= 25 ? "low" : "medium";
  return { band, confidence: accountConfidence, evidence: { mrrContributionCents: mrr, percentileWithinAccount: percentile } };
}

function percentileRank(value: number, sortedAsc: readonly number[]): number {
  if (sortedAsc.length === 0) return 100;
  let belowOrEqual = 0;
  for (const v of sortedAsc) {
    if (v <= value) belowOrEqual++;
    else break;
  }
  return (belowOrEqual / sortedAsc.length) * 100;
}

// ---- the table (Recova's recommend.ts) ----------------------------------------

export interface Recommendation {
  action: RecommendedAction;
  rationale: string;
  /** Recova's estimated_mrr_at_risk_cents: MRR times 12, so a year of revenue,
   *  named for what it is. Set only for the two actions that ask for attention. */
  annualizedMrrAtRiskCents: number | null;
  confidence: RecommendationConfidence;
}

export function lookupRecommendation(
  engagement: EngagementBand,
  history: RecoveryBand,
  value: ValueBand,
  mrrContributionCents: number,
): Recommendation {
  const { action, rationale } = lookupActionAndRationale(engagement, history, value);
  const annualizedMrrAtRiskCents =
    action === "personal_outreach" || action === "continue_automated_priority"
      ? Math.max(0, Math.round(mrrContributionCents * ANNUALIZE_MONTHS))
      : null;
  return { action, rationale, annualizedMrrAtRiskCents, confidence: computeConfidence(engagement, history, value, action) };
}

type ActionAndRationale = { action: RecommendedAction; rationale: string };

function lookupActionAndRationale(engagement: EngagementBand, history: RecoveryBand, value: ValueBand): ActionAndRationale {
  const isHigh = value === "high";

  if (engagement === "green") {
    if (history === "green") {
      return {
        action: "continue_automated",
        rationale:
          "Automated recovery is highly effective for this customer (engaged, 60%+ historical recovery rate). No intervention needed.",
      };
    }
    if (history === "yellow") {
      return {
        action: "continue_automated",
        rationale: "Customer engages with email and recovers some of the time. Automated flow is doing its job.",
      };
    }
    if (history === "red") {
      if (isHigh) {
        return {
          action: "personal_outreach",
          // Recova: "... Personal outreach this week is the highest-yield action."
          // Nothing measures yield yet.
          rationale:
            "High-value customer who engages with email but rarely recovers via automation. Try personal outreach this week.",
        };
      }
      return {
        action: "continue_automated_deprioritize",
        rationale:
          "Customer engages with email but historically recovers <30% of the time. Continue automated; don't expect recovery.",
      };
    }
    if (isHigh) {
      return {
        action: "continue_automated_priority",
        rationale: "High-value customer engaging with email; not enough history to predict recovery rate. Watch closely.",
      };
    }
    return {
      action: "continue_automated",
      rationale: "Customer engages with email; not enough history to call it. Standard automated flow.",
    };
  }

  if (engagement === "yellow") {
    if (isHigh) {
      return {
        action: "personal_outreach",
        // Recova: "... Personal note now is the integrity move." An opinion
        // stated as a finding.
        rationale: "High-value customer with declining engagement. Send a personal note now.",
      };
    }
    if (history === "green") {
      return {
        action: "continue_automated",
        rationale: "Engagement softening but historical recovery is strong. Trust the flow.",
      };
    }
    if (history === "yellow") {
      return { action: "continue_automated", rationale: "Mixed signals across the board. Standard automated flow." };
    }
    if (history === "red") {
      return {
        action: "continue_automated_deprioritize",
        rationale: "Soft engagement, weak recovery history. Low-yield case; deprioritize.",
      };
    }
    return {
      action: "continue_automated",
      rationale: "Engagement softening; not enough history to call it. Standard automated flow.",
    };
  }

  if (engagement === "red") {
    if (history === "green") {
      if (isHigh) {
        return {
          action: "personal_outreach",
          // Recova: "... but has stopped engaging entirely. Email isn't reaching
          // them: reach out directly." No tracked open cannot show either: a
          // blocked pixel or a click without images leaves no open.
          rationale:
            "High-value customer who used to recover well but has no tracked email opens in the last 30 days. Reach out directly.",
        };
      }
      return {
        action: "personal_outreach",
        // Recova: "Customer used to recover well but has stopped engaging. ..."
        // Nothing shows they once engaged, or that they stopped.
        rationale:
          "Customer used to recover well but has no tracked email opens in the last 30 days. Worth one direct touch before deprioritizing.",
      };
    }
    if (history === "yellow") {
      if (isHigh) {
        return {
          action: "personal_outreach",
          // Recova: "... Direct outreach is the integrity move." An opinion
          // stated as a finding.
          rationale: "High-value customer not engaging; mixed history. Reach out directly.",
        };
      }
      return {
        action: "continue_automated_deprioritize",
        rationale: "Not engaging; mixed history. Continue automated but don't expect much.",
      };
    }
    if (history === "red") {
      if (isHigh) {
        return {
          action: "personal_outreach",
          rationale:
            "High-value customer not engaging and historically doesn't recover. Last-chance personal touch before deprioritizing.",
        };
      }
      return {
        action: "continue_automated_deprioritize",
        rationale:
          "Not engaging; historically doesn't recover. Lowest-yield case. Continue automated but stop investing attention.",
      };
    }
    if (isHigh) {
      return {
        action: "personal_outreach",
        rationale: "High-value customer not engaging; not enough history to call it. Direct outreach.",
      };
    }
    return {
      action: "continue_automated",
      rationale: "Not engaging; no history to call it. Standard automated flow until we have data.",
    };
  }

  if (isHigh) {
    return {
      action: "continue_automated_priority",
      rationale: "High-value customer; not enough engagement data to call it. Watch closely.",
    };
  }
  return { action: "continue_automated", rationale: "Not enough engagement data. Standard automated flow." };
}

function computeConfidence(
  engagement: EngagementBand,
  history: RecoveryBand,
  value: ValueBand,
  action: RecommendedAction,
): RecommendationConfidence {
  const unknowns = (engagement === "unknown" ? 1 : 0) + (history === "unknown" ? 1 : 0);
  if (unknowns >= 2) return "low";
  if (value === "low") return "low";
  if (unknowns === 1) return "medium";
  if (value === "medium") return "medium";
  if (value === "high" || action === "continue_automated") return "high";
  return "medium";
}

// ---- one customer, end to end -------------------------------------------------

export interface CustomerRecommendation {
  engagement: EngagementHealth;
  history: RecoveryHistory;
  value: CustomerValue;
  recommendation: Recommendation;
}

export function recommendCustomer(input: {
  engagement: EngagementInput;
  failedPaymentCount: number;
  recoveredCount: number;
  mrrContributionCents: number;
  accountMrrAscending: readonly number[];
}): CustomerRecommendation {
  const engagement = engagementBand(input.engagement);
  const history = recoveryHistoryBand(input);
  const value = customerValueBand(input);
  const recommendation = lookupRecommendation(engagement.band, history.band, value.band, input.mrrContributionCents);
  return { engagement, history, value, recommendation };
}
