import { DAY_MS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import type { disputeApprovals, disputeEvidence, disputes, earlyFraudWarnings } from "~/db";
import { disputeFeeCents } from "~/lib/billing/fees";

// Disputes seed (TASK-foxhound-demo-data-engine.md Phase 3): the legacy
// 8-dispute Teamflow set, ported near-verbatim, mapped onto Foxhound's dispute
// state machine (draft|pending_review|submitted|resolved_won|resolved_lost)
// and approval gate. Pure: returns plain insert rows; app/lib/demo/seed.ts
// turns these into db.insert(...) batches.
//
// Legacy stamped its dispute #1 (originally a placeholder "Jane Kim" row) with
// Harborline Group's identity in a second pass from the Intelligence seed
// script, so the two module boundaries agreed on one shared UUID. Foxhound
// builds it as Harborline's dispute directly: no placeholder, no second pass.
//
// Approval-gate fidelity (PRICING.md rev 3: "billable only if Foxhound drafted
// AND submitted the evidence"): only the disputes Foxhound actually took
// through approve-and-submit (see app/lib/disputes/approval.server.ts) get a
// dispute_approvals row and a submitted_at. Dispute #5 (Sara Lin) is won but
// was submitted by the merchant directly / resolved by Stripe without
// Foxhound's evidence, so it carries NO approval row and NO resolved fee, even
// though its state is resolved_won, exactly mirroring the real non-billable
// case the billable.ts predicate exists to exclude.

export type DisputeInsert = typeof disputes.$inferInsert;
type DisputeEvidenceInsert = typeof disputeEvidence.$inferInsert;
type DisputeApprovalInsert = typeof disputeApprovals.$inferInsert;

export interface DisputesSeedResult {
  disputes: DisputeInsert[];
  disputeEvidence: DisputeEvidenceInsert[];
  disputeApprovals: DisputeApprovalInsert[];
}

interface DisputeSpec {
  id: string;
  stripeCustomerId: string;
  customerName: string;
  customerEmail: string;
  amountCents: number;
  reason: string;
  state: "pending_review" | "submitted" | "resolved_won" | "resolved_lost";
  /** null = not yet Foxhound-submitted (still pending_review or merchant-won). */
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
  /** null = evidence deadline still in the future (open dispute). */
  resolvedDaysAgo: number | null;
}

const DISPUTE_SPECS: DisputeSpec[] = [
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
    customerEmail: "marcus.v@devtools.co",
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
    customerEmail: "priya.n@saasflow.com",
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
    customerEmail: "tyler.m@growthhq.co",
    amountCents: 9900,
    reason: "subscription_canceled",
    state: "pending_review",
    foxhoundSubmitted: false,
    triageRecommendation: "fight",
    triageConfidence: 74,
    triageReasoning: "Subscription dispute with prior payment history.",
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
    customerEmail: "sara.l@founderkit.io",
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
    customerEmail: "james.p@metrics.io",
    amountCents: 9900,
    reason: "unrecognized",
    state: "pending_review",
    foxhoundSubmitted: false,
    triageRecommendation: "accept",
    triageConfidence: 68,
    triageReasoning: "Low amount with a failing AVS check and elevated risk. The counter fee may exceed recovery value.",
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
    customerEmail: "amy.c@novalabs.co",
    amountCents: 49900,
    reason: "fraudulent",
    state: "resolved_won",
    foxhoundSubmitted: true,
    triageRecommendation: "fight",
    triageConfidence: 94,
    triageReasoning: "18 prior charges, the lowest Radar risk score in the book, and recovery-email engagement. An exceptionally strong case.",
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
    customerEmail: "raj.p@buildfast.io",
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

/** Build the 8-dispute Teamflow set. `memberEmail` is the demo account's
 *  single member, used as the approver on Foxhound-submitted disputes (the
 *  real flow stamps submitted_by with the approver's email, not a brand name). */
export function buildDisputesSeed(accountId: string, now: Date, memberEmail: string): DisputesSeedResult {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const disputeRows: DisputeInsert[] = [];
  const evidenceRows: DisputeEvidenceInsert[] = [];
  const approvalRows: DisputeApprovalInsert[] = [];

  for (const spec of DISPUTE_SPECS) {
    const createdAt = ago(spec.createdDaysAgo);
    const resolvedAt = spec.resolvedDaysAgo !== null ? ago(spec.resolvedDaysAgo) : null;
    const won = spec.state === "resolved_won";
    // Approved a day or two after the dispute was created; submitted right after.
    const approvedAt = spec.foxhoundSubmitted ? ago(Math.max(0, spec.createdDaysAgo - 1)) : null;
    const resolvedFeeCents = won && spec.foxhoundSubmitted ? disputeFeeCents(spec.amountCents, DISPUTE_FEE_CAP_CENTS) : null;

    disputeRows.push({
      id: spec.id,
      accountId,
      stripeDisputeId: `dstripe_dp_${spec.id}`,
      stripeChargeId: `dstripe_ch_${spec.id}`,
      stripeCustomerId: spec.stripeCustomerId,
      customerEmail: spec.customerEmail,
      customerName: spec.customerName,
      amountCents: spec.amountCents,
      currency: "usd",
      reason: spec.reason,
      // Real intake (webhooks/batches.ts buildDisputeIntakeBatch) snapshots the
      // Stripe dispute status at charge.dispute.created and never touches it
      // again on resolution (only `state` advances), so every seeded row keeps
      // its intake-time status regardless of outcome.
      status: "needs_response",
      outcome: spec.state === "resolved_won" ? "won" : spec.state === "resolved_lost" ? "lost" : null,
      outcomeAmountCents: won ? spec.amountCents : null,
      evidenceDeadline: resolvedAt ? new Date(resolvedAt.getTime() - 7 * DAY_MS) : new Date(now.getTime() + 10 * DAY_MS),
      submittedAt: approvedAt,
      // Real code only ever writes submittedBy from buildSubmissionConfirmationBatch,
      // gated on a Foxhound submission; a merchant-fought win never sets it.
      submittedBy: spec.foxhoundSubmitted ? memberEmail : null,
      createdAt,
      resolvedAt,
      avsResult: spec.avsResult,
      cvvResult: spec.cvvResult,
      radarRiskScore: spec.radarRiskScore,
      radarRiskLevel: spec.radarRiskLevel,
      priorChargesCount: spec.priorChargesCount,
      priorChargesTotal: spec.priorChargesTotal,
      smartDisputesStatus: spec.smartDisputesStatus,
      triageRecommendation: spec.triageRecommendation,
      triageConfidence: spec.triageConfidence,
      triageReasoning: spec.triageReasoning,
      stagedAt: ago(spec.createdDaysAgo),
      outcomeNotifiedAt: resolvedAt,
      state: spec.state,
      resolvedFeeCents,
      resolvedFeeCurrency: resolvedFeeCents !== null ? "usd" : null,
    });

    if (spec.state !== "pending_review" || spec.foxhoundSubmitted) {
      evidenceRows.push(
        {
          id: `${spec.id}_ev_desc`,
          disputeId: spec.id,
          accountId,
          fieldName: "product_description",
          fieldValue: "Monthly subscription, billed automatically. Active account with a clean payment history prior to this charge.",
          createdAt,
        },
        {
          id: `${spec.id}_ev_comm`,
          disputeId: spec.id,
          accountId,
          fieldName: "customer_communication",
          fieldValue: "The customer's account shows normal usage in the billing cycle immediately before the disputed charge.",
          createdAt,
        },
      );
    }

    if (spec.foxhoundSubmitted && approvedAt) {
      approvalRows.push({
        id: `${spec.id}_approval`,
        disputeId: spec.id,
        accountId,
        approvedByEmail: memberEmail,
        evidenceVersionHash: `demo_hash_${spec.id}`,
        approvedAt,
      });
    }
  }

  return { disputes: disputeRows, disputeEvidence: evidenceRows, disputeApprovals: approvalRows };
}

type EarlyFraudWarningInsert = typeof earlyFraudWarnings.$inferInsert;

/** Four early fraud warnings on Teamflow customers: three still open, one the
 *  merchant refunded. No stripe connection is referenced, as with the disputes. */
export function buildEarlyFraudWarningsSeed(accountId: string, now: Date): EarlyFraudWarningInsert[] {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const specs = [
    { n: 1, name: "Northwind Labs", email: "ap@northwind-labs.demo", cents: 29900, type: "made_with_stolen_card", days: 1, refunded: false },
    { n: 2, name: "Lumen Studio", email: "finance@lumen-studio.demo", cents: 14900, type: "unauthorized_use_of_card", days: 3, refunded: false },
    { n: 3, name: null, email: "j.ortega@mailbox.demo", cents: 4900, type: "card_never_received", days: 6, refunded: false },
    { n: 4, name: "Cobalt Freight", email: "billing@cobalt-freight.demo", cents: 9900, type: "made_with_lost_card", days: 12, refunded: true },
  ];
  return specs.map((s) => ({
    id: `defw_${s.n}`,
    accountId,
    stripeWarningId: `dstripe_issfr_${s.n}`,
    stripeChargeId: `dstripe_ch_efw_${s.n}`,
    stripePaymentIntentId: `dstripe_pi_efw_${s.n}`,
    stripeCustomerId: `cus_teamflow_efw_${s.n}`,
    customerEmail: s.email,
    customerName: s.name,
    fraudType: s.type,
    actionable: !s.refunded,
    amountCents: s.cents,
    currency: "usd",
    createdAt: ago(s.days),
    receivedAt: ago(s.days),
    refundedAt: s.refunded ? ago(s.days - 1) : null,
    stripeRefundId: s.refunded ? `dstripe_re_efw_${s.n}` : null,
  }));
}
