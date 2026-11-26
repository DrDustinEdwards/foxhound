// Dispute #5 (Sara Lin) is won but was submitted by the merchant directly /
// resolved by Stripe without Foxhound's evidence, so it carries NO approval row
// and NO resolved fee, even though its state is resolved_won, exactly mirroring
// the real non-billable case the billable.ts predicate exists to exclude.

export interface DisputeSpec {
  id: string;
  stripeCustomerId: string;
  customerName: string;
  customerEmail: string;
  amountCents: number;
  reason: string;
  state: "pending_review" | "submitted" | "resolved_won" | "resolved_lost";
  foxhoundSubmitted: boolean;
  triageRecommendation: "fight" | "accept";
  triageConfidence: number;
  triageReasoning: string;
  priorChargesCount: number;
  priorChargesTotal: number;
  avsResult: string;
  cvvResult: string;
  radarRiskScore: number;
  radarRiskLevel: string;
  smartDisputesStatus: string;
  createdDaysAgo: number;
  resolvedDaysAgo: number | null;
  /**
   * Stripe's status, when it is not intake's needs_response: an inquiry carries
   * warning_needs_response.
   */
  stripeStatus?: string;
}

export const TEAMFLOW_DISPUTE_SPECS: DisputeSpec[] = [
  {
    id: "ddisp_1",
    stripeCustomerId: "cus_teamflow_harborline_group",
    customerName: "Harborline Group",
    customerEmail: "billing@harborline-group.demo",
    amountCents: 34900,
    reason: "fraudulent",
    state: "resolved_won",
    foxhoundSubmitted: true,
    triageRecommendation: "fight",
    triageConfidence: 88,
    triageReasoning: "12 prior successful charges with passing card verification.",
    priorChargesCount: 12,
    priorChargesTotal: 187600,
    avsResult: "pass",
    cvvResult: "pass",
    radarRiskScore: 14,
    radarRiskLevel: "normal",
    smartDisputesStatus: "not_eligible",
    createdDaysAgo: 26,
    resolvedDaysAgo: 5,
  },
  {
    id: "ddisp_2",
    stripeCustomerId: "ddisp_cus_marcus_vance",
    customerName: "Marcus Vance",
    customerEmail: "marcus.v@devtools.demo",
    amountCents: 14900,
    reason: "subscription_canceled",
    state: "pending_review",
    foxhoundSubmitted: false,
    triageRecommendation: "fight",
    triageConfidence: 82,
    triageReasoning: "Subscription dispute with 7 months of prior payments.",
    priorChargesCount: 7,
    priorChargesTotal: 89600,
    avsResult: "pass",
    cvvResult: "pass",
    radarRiskScore: 22,
    radarRiskLevel: "normal",
    smartDisputesStatus: "not_eligible",
    createdDaysAgo: 4,
    resolvedDaysAgo: null,
  },
  {
    id: "ddisp_3",
    stripeCustomerId: "ddisp_cus_priya_nair",
    customerName: "Priya Nair",
    customerEmail: "priya.n@saasflow.demo",
    amountCents: 49900,
    reason: "fraudulent",
    state: "pending_review",
    foxhoundSubmitted: false,
    triageRecommendation: "fight",
    triageConfidence: 71,
    triageReasoning:
      "3 prior charges and Smart Disputes eligible. Recovery email history added as supplemental evidence.",
    priorChargesCount: 3,
    priorChargesTotal: 89700,
    avsResult: "pass",
    cvvResult: "unavailable",
    radarRiskScore: 41,
    radarRiskLevel: "elevated",
    smartDisputesStatus: "available",
    createdDaysAgo: 9,
    resolvedDaysAgo: null,
  },
  {
    id: "ddisp_4",
    stripeCustomerId: "ddisp_cus_tyler_moore",
    customerName: "Tyler Moore",
    customerEmail: "tyler.m@growthhq.demo",
    amountCents: 9900,
    reason: "subscription_canceled",
    state: "pending_review",
    foxhoundSubmitted: false,
    triageRecommendation: "fight",
    triageConfidence: 74,
    triageReasoning: "Subscription dispute with prior payment history.",
    // The demo's inquiry: the issuer is asking before any chargeback, so Stripe
    // has moved no money for it.
    stripeStatus: "warning_needs_response",
    priorChargesCount: 2,
    priorChargesTotal: 17800,
    avsResult: "pass",
    cvvResult: "pass",
    radarRiskScore: 18,
    radarRiskLevel: "normal",
    smartDisputesStatus: "not_eligible",
    createdDaysAgo: 1,
    resolvedDaysAgo: null,
  },
  {
    id: "ddisp_5",
    stripeCustomerId: "ddisp_cus_sara_lin",
    customerName: "Sara Lin",
    customerEmail: "sara.l@founderkit.demo",
    amountCents: 24900,
    reason: "fraudulent",
    state: "resolved_won",
    // Won, but the merchant (or Stripe) submitted it directly: never billable.
    foxhoundSubmitted: false,
    triageRecommendation: "fight",
    triageConfidence: 85,
    triageReasoning: "5 prior charges. Evidence added to the Smart Disputes packet.",
    priorChargesCount: 5,
    priorChargesTotal: 74500,
    avsResult: "pass",
    cvvResult: "pass",
    radarRiskScore: 11,
    radarRiskLevel: "normal",
    smartDisputesStatus: "available",
    createdDaysAgo: 44,
    resolvedDaysAgo: 18,
  },
  {
    id: "ddisp_6",
    stripeCustomerId: "ddisp_cus_james_park",
    customerName: "James Park",
    customerEmail: "james.p@metrics.demo",
    amountCents: 9900,
    reason: "unrecognized",
    state: "pending_review",
    foxhoundSubmitted: false,
    triageRecommendation: "accept",
    triageConfidence: 68,
    triageReasoning:
      "Low amount with a failing AVS check and elevated risk. The counter fee may exceed recovery value.",
    priorChargesCount: 1,
    priorChargesTotal: 9900,
    avsResult: "fail",
    cvvResult: "pass",
    radarRiskScore: 62,
    radarRiskLevel: "elevated",
    smartDisputesStatus: "not_eligible",
    createdDaysAgo: 6,
    resolvedDaysAgo: null,
  },
  {
    id: "ddisp_7",
    stripeCustomerId: "ddisp_cus_amy_chen",
    customerName: "Amy Chen",
    customerEmail: "amy.c@novalabs.demo",
    amountCents: 49900,
    reason: "fraudulent",
    state: "resolved_won",
    foxhoundSubmitted: true,
    triageRecommendation: "fight",
    triageConfidence: 94,
    triageReasoning:
      "18 prior charges, the lowest Radar risk score in the book, and recovery-email engagement. An exceptionally strong case.",
    priorChargesCount: 18,
    priorChargesTotal: 498200,
    avsResult: "pass",
    cvvResult: "pass",
    radarRiskScore: 8,
    radarRiskLevel: "normal",
    smartDisputesStatus: "not_eligible",
    createdDaysAgo: 38,
    resolvedDaysAgo: 11,
  },
  {
    id: "ddisp_8",
    stripeCustomerId: "ddisp_cus_raj_patel",
    customerName: "Raj Patel",
    customerEmail: "raj.p@buildfast.demo",
    amountCents: 14900,
    reason: "subscription_canceled",
    state: "resolved_lost",
    foxhoundSubmitted: true,
    triageRecommendation: "fight",
    triageConfidence: 61,
    triageReasoning: "Subscription dispute submitted with the evidence available at the time.",
    priorChargesCount: 2,
    priorChargesTotal: 29800,
    avsResult: "pass",
    cvvResult: "unavailable",
    radarRiskScore: 45,
    radarRiskLevel: "elevated",
    smartDisputesStatus: "not_eligible",
    createdDaysAgo: 33,
    resolvedDaysAgo: 13,
  },
];

export const BOLT_DISPUTE_SPECS: DisputeSpec[] = [
  {
    id: "ddisp_bolt_1",
    stripeCustomerId: "cus_bolt_dispute_lane_owens",
    customerName: "Lane Owens",
    customerEmail: "lane.owens@apex-stack.demo",
    amountCents: 9900,
    reason: "fraudulent",
    state: "resolved_won",
    foxhoundSubmitted: true,
    triageRecommendation: "fight",
    triageConfidence: 86,
    triageReasoning:
      "6 prior successful charges, low Radar risk, and recovery email engagement on earlier failures.",
    priorChargesCount: 6,
    priorChargesTotal: 59400,
    avsResult: "pass",
    cvvResult: "pass",
    radarRiskScore: 12,
    radarRiskLevel: "normal",
    smartDisputesStatus: "not_eligible",
    createdDaysAgo: 20,
    resolvedDaysAgo: 2,
  },
  {
    id: "ddisp_bolt_2",
    stripeCustomerId: "cus_bolt_dispute_sage_pulse",
    customerName: "Sage Pulse",
    customerEmail: "billing@sagepulse.demo",
    amountCents: 9900,
    reason: "subscription_canceled",
    state: "resolved_lost",
    foxhoundSubmitted: true,
    triageRecommendation: "fight",
    triageConfidence: 52,
    triageReasoning:
      "Subscription dispute. The evidence is weaker than ideal but worth submitting.",
    priorChargesCount: 2,
    priorChargesTotal: 19800,
    avsResult: "pass",
    cvvResult: "unavailable",
    radarRiskScore: 38,
    radarRiskLevel: "elevated",
    smartDisputesStatus: "not_eligible",
    createdDaysAgo: 28,
    resolvedDaysAgo: 8,
  },
  {
    id: "ddisp_bolt_3",
    stripeCustomerId: "cus_bolt_dispute_drift_logic",
    customerName: "Drift Logic",
    customerEmail: "admin@driftlogic.demo",
    amountCents: 9900,
    reason: "product_not_received",
    state: "pending_review",
    foxhoundSubmitted: false,
    triageRecommendation: "fight",
    triageConfidence: 70,
    triageReasoning: "Stable subscription customer with engagement history.",
    priorChargesCount: 4,
    priorChargesTotal: 39600,
    avsResult: "pass",
    cvvResult: "pass",
    radarRiskScore: 18,
    radarRiskLevel: "normal",
    smartDisputesStatus: "not_eligible",
    createdDaysAgo: 3,
    resolvedDaysAgo: null,
  },
];
