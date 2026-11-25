import { DAY_MS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { daysAgo } from "./customer-base";
import type {
  disputeApprovals,
  disputeBalanceTransactions,
  disputeEvidence,
  disputes,
  earlyFraudWarnings,
} from "~/db";
import { disputeFeeCents } from "~/lib/billing/fees";
import { type DisputeSpec, TEAMFLOW_DISPUTE_SPECS } from "./disputes-specs";

export type DisputeInsert = typeof disputes.$inferInsert;
type DisputeEvidenceInsert = typeof disputeEvidence.$inferInsert;
type DisputeApprovalInsert = typeof disputeApprovals.$inferInsert;
type DisputeBalanceTransactionInsert = typeof disputeBalanceTransactions.$inferInsert;

export interface DisputesSeedResult {
  disputes: DisputeInsert[];
  disputeEvidence: DisputeEvidenceInsert[];
  disputeApprovals: DisputeApprovalInsert[];
  disputeBalanceTransactions: DisputeBalanceTransactionInsert[];
}

const DEMO_STRIPE_DISPUTE_FEE_CENTS = 1500;

/**
 * Build a demo business's dispute set (Teamflow's eight unless `specs` names
 * another). `memberEmail` is the demo account's single member, used as the
 * approver on Foxhound-submitted disputes (the real flow stamps submitted_by
 * with the approver's email, not a brand name).
 */
export function buildDisputesSeed(
  accountId: string,
  now: Date,
  memberEmail: string,
  specs: DisputeSpec[] = TEAMFLOW_DISPUTE_SPECS,
): DisputesSeedResult {
  const disputeRows: DisputeInsert[] = [];
  const evidenceRows: DisputeEvidenceInsert[] = [];
  const approvalRows: DisputeApprovalInsert[] = [];
  const fundsRows: DisputeBalanceTransactionInsert[] = [];

  for (const spec of specs) {
    const createdAt = daysAgo(now, spec.createdDaysAgo);
    const resolvedAt = spec.resolvedDaysAgo !== null ? daysAgo(now, spec.resolvedDaysAgo) : null;
    const won = spec.state === "resolved_won";
    const approvedAt = spec.foxhoundSubmitted
      ? daysAgo(now, Math.max(0, spec.createdDaysAgo - 1))
      : null;
    const resolvedFeeCents =
      won && spec.foxhoundSubmitted
        ? disputeFeeCents(spec.amountCents, DISPUTE_FEE_CAP_CENTS)
        : null;

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
      status: spec.stripeStatus ?? "needs_response",
      outcome:
        spec.state === "resolved_won" ? "won" : spec.state === "resolved_lost" ? "lost" : null,
      outcomeAmountCents: won ? spec.amountCents : null,
      evidenceDeadline: resolvedAt
        ? new Date(resolvedAt.getTime() - 7 * DAY_MS)
        : new Date(now.getTime() + 10 * DAY_MS),
      submittedAt: approvedAt,
      // Real code only ever writes submittedBy from
      // buildSubmissionConfirmationBatch, gated on a Foxhound submission; a
      // merchant-fought win never sets it.
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
      stagedAt: daysAgo(now, spec.createdDaysAgo),
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
          fieldValue:
            "Monthly subscription, billed automatically. Active account with a clean payment history prior to this charge.",
          createdAt,
        },
        {
          id: `${spec.id}_ev_comm`,
          disputeId: spec.id,
          accountId,
          fieldName: "customer_communication",
          fieldValue:
            "The customer's account shows normal usage in the billing cycle immediately before the disputed charge.",
          createdAt,
        },
      );
    }

    // Stripe withdraws a chargeback's amount and its dispute fee when the
    // dispute opens, and reinstates the amount on a win. An inquiry moves no
    // money.
    if (!spec.stripeStatus?.startsWith("warning_")) {
      const stripeDisputeId = `dstripe_dp_${spec.id}`;
      fundsRows.push({
        id: `${spec.id}_bt_withdrawn`,
        accountId,
        stripeDisputeId,
        stripeBalanceTransactionId: `dstripe_txn_${spec.id}_withdrawn`,
        kind: "withdrawn",
        amountCents: -spec.amountCents,
        feeCents: DEMO_STRIPE_DISPUTE_FEE_CENTS,
        currency: "usd",
        occurredAt: createdAt,
        createdAt,
      });
      if (won && resolvedAt) {
        fundsRows.push({
          id: `${spec.id}_bt_reinstated`,
          accountId,
          stripeDisputeId,
          stripeBalanceTransactionId: `dstripe_txn_${spec.id}_reinstated`,
          kind: "reinstated",
          amountCents: spec.amountCents,
          feeCents: 0,
          currency: "usd",
          occurredAt: resolvedAt,
          createdAt: resolvedAt,
        });
      }
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

  return {
    disputes: disputeRows,
    disputeEvidence: evidenceRows,
    disputeApprovals: approvalRows,
    disputeBalanceTransactions: fundsRows,
  };
}

type EarlyFraudWarningInsert = typeof earlyFraudWarnings.$inferInsert;

/**
 * Four early fraud warnings on Teamflow customers: three still open, one the
 * merchant refunded. No stripe connection is referenced, as with the disputes.
 */
export function buildEarlyFraudWarningsSeed(
  accountId: string,
  now: Date,
): EarlyFraudWarningInsert[] {
  const specs = [
    {
      n: 1,
      name: "Northwind Labs",
      email: "ap@northwind-labs.demo",
      cents: 29900,
      type: "made_with_stolen_card",
      days: 1,
      refunded: false,
    },
    {
      n: 2,
      name: "Lumen Studio",
      email: "finance@lumen-studio.demo",
      cents: 14900,
      type: "unauthorized_use_of_card",
      days: 3,
      refunded: false,
    },
    {
      n: 3,
      name: null,
      email: "j.ortega@mailbox.demo",
      cents: 4900,
      type: "card_never_received",
      days: 6,
      refunded: false,
    },
    {
      n: 4,
      name: "Cobalt Freight",
      email: "billing@cobalt-freight.demo",
      cents: 9900,
      type: "made_with_lost_card",
      days: 12,
      refunded: true,
    },
  ];
  return specs.map((s) => ({
    id: `${accountId}_efw_${s.n}`,
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
    createdAt: daysAgo(now, s.days),
    receivedAt: daysAgo(now, s.days),
    refundedAt: s.refunded ? daysAgo(now, s.days - 1) : null,
    stripeRefundId: s.refunded ? `dstripe_re_efw_${s.n}` : null,
  }));
}
