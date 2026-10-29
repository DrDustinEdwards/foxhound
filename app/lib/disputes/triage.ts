// Recova's dispute context and triage, ported from lib/disputes-evidence.ts
// (blob 2d5e7af6) and components/disputes/formatters.tsx (blob 81bf7f8b), both
// read whole. Recova read the disputed charge, the customer's prior charges and
// their subscription from Stripe at intake, stored them on the dispute, and
// recommended fighting or accepting from them. Foxhound does the same: the
// Stripe reads are in context.server.ts, and this module is the pure half the
// intake, the notice and the dispute page share.
//
// CLIENT-SAFE BY CONSTRUCTION: the dispute page calls the formatters, so this
// module imports nothing from a `.server` file (RULES.md 4.5).

export interface PriorCharge {
  date: string;
  amount: number;
  currency: string;
  status: string;
}

export interface DisputeSubscription {
  id: string;
  status: string;
  start_date: string | null;
  canceled_at: string | null;
  plan_amount: number | null;
}

/** What Stripe says about the disputed charge and its customer. Every field is
 *  null (or zero) when Stripe could not be read, so intake never waits on it. */
export interface DisputeContext {
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerIp: string | null;
  billingAddress: string | null;
  avsResult: string | null;
  cvvResult: string | null;
  radarRiskScore: number | null;
  radarRiskLevel: string | null;
  threeDSecure: string | null;
  serviceDate: Date | null;
  priorChargesCount: number;
  priorChargesTotal: number;
  priorChargesJson: PriorCharge[];
  subscriptionJson: DisputeSubscription | null;
  smartDisputesStatus: string | null;
}

export function emptyDisputeContext(customerId: string | null = null): DisputeContext {
  return {
    customerId,
    customerName: null,
    customerEmail: null,
    customerIp: null,
    billingAddress: null,
    avsResult: null,
    cvvResult: null,
    radarRiskScore: null,
    radarRiskLevel: null,
    threeDSecure: null,
    serviceDate: null,
    priorChargesCount: 0,
    priorChargesTotal: 0,
    priorChargesJson: [],
    subscriptionJson: null,
    smartDisputesStatus: null,
  };
}

export interface TriageResult {
  recommendation: "fight" | "accept";
  confidence: number;
  reasoning: string;
}

/** Recova's calculateTriage, rule for rule and word for word. */
export function calculateTriage(
  context: DisputeContext,
  disputeAmountCents: number,
  reason: string,
  shipsPhysical: boolean,
): TriageResult {
  const avsPass = context.avsResult?.includes("pass") ?? false;
  const cvvPass = context.cvvResult === "pass";

  if (reason === "fraudulent") {
    if (context.priorChargesCount >= 3 && avsPass && cvvPass) {
      return {
        recommendation: "fight",
        confidence: 85,
        reasoning: `${context.priorChargesCount} prior successful charges, AVS and CVV both passed.`,
      };
    }
    if (context.priorChargesCount >= 1) {
      return {
        recommendation: "fight",
        confidence: 65,
        reasoning: `${context.priorChargesCount} prior successful charge(s) establish an ongoing relationship.`,
      };
    }
  }

  if (reason === "subscription_canceled") {
    return {
      recommendation: "fight",
      confidence: 80,
      reasoning: "Subscription billing disputes are generally winnable with Stripe timeline records.",
    };
  }

  if (reason === "product_not_received") {
    if (shipsPhysical) {
      return {
        recommendation: "accept",
        confidence: 70,
        reasoning:
          "Physical-goods merchant with no tracking evidence attached. Not winnable without proof of delivery.",
      };
    }
    return {
      recommendation: "fight",
      confidence: 75,
      reasoning: "Digital or SaaS delivery. Access logs and account activity generally carry this case.",
    };
  }

  if (disputeAmountCents < 5000) {
    return {
      recommendation: "accept",
      confidence: 60,
      reasoning: "Dispute amount under $50. Time cost of fighting exceeds expected recovery.",
    };
  }

  return {
    recommendation: "fight",
    confidence: 55,
    reasoning: "Default: marginal case. Submit structured evidence and let the bank decide.",
  };
}

/**
 * The Stripe evidence fields Recova's buildEvidenceFields filled from this
 * context: each one read straight off Stripe, never phrased by a model, and left
 * out when Stripe had nothing (Stripe rejects empty strings). Recova's
 * uncategorized_text fact list is not here, because Foxhound's grounded draft
 * (evidence.ts) owns that field.
 */
export function contextEvidenceFields(context: DisputeContext): { fieldName: string; fieldValue: string }[] {
  const fields: { fieldName: string; fieldValue: string }[] = [];
  const add = (fieldName: string, value: string | null) => {
    if (value) fields.push({ fieldName, fieldValue: value });
  };
  add("customer_name", context.customerName);
  add("customer_email_address", context.customerEmail);
  add("customer_purchase_ip", context.customerIp);
  add("billing_address", context.billingAddress);
  const sub = context.subscriptionJson;
  if (sub) {
    const parts = [`Subscription ${sub.id} status ${sub.status}.`];
    if (sub.start_date) parts.push(`Started ${sub.start_date.slice(0, 10)}.`);
    if (sub.canceled_at) parts.push(`Canceled ${sub.canceled_at.slice(0, 10)}.`);
    add("subscription_information", parts.join(" "));
  }
  return fields;
}

/** The dispute row's context and triage columns, as the intake writes them
 *  (Recova's handleDisputeCreated upsert). */
export function disputeContextColumns(context: DisputeContext, triage: TriageResult) {
  return {
    customerIp: context.customerIp,
    billingAddress: context.billingAddress,
    avsResult: context.avsResult,
    cvvResult: context.cvvResult,
    radarRiskScore: context.radarRiskScore,
    radarRiskLevel: context.radarRiskLevel,
    threeDSecure: context.threeDSecure,
    priorChargesCount: context.priorChargesCount,
    priorChargesTotal: context.priorChargesTotal,
    priorChargesJson: context.priorChargesJson,
    subscriptionJson: context.subscriptionJson,
    smartDisputesStatus: context.smartDisputesStatus,
    triageRecommendation: triage.recommendation,
    triageConfidence: triage.confidence,
    triageReasoning: triage.reasoning,
  };
}

export type DisputeContextColumns = ReturnType<typeof disputeContextColumns>;

/** Recova's humanCardCheck. */
export function humanCardCheck(raw: string | null): string {
  if (!raw) return "Unavailable";
  const map: Record<string, string> = {
    pass: "Pass",
    fail: "Fail",
    unavailable: "Unavailable",
    unchecked: "Not checked",
  };
  return map[raw] ?? raw;
}

/** Recova's humanSmartDisputes. */
export function humanSmartDisputes(raw: string | null): string {
  if (!raw) return "Unknown";
  const map: Record<string, string> = {
    available: "Eligible",
    not_eligible: "Not eligible",
    requires_evidence: "Requires more data",
  };
  return map[raw] ?? raw;
}

/** Recova's humanRadarLevel. */
export function humanRadarLevel(raw: string | null): string {
  if (!raw) return "";
  const map: Record<string, string> = { normal: "Normal", elevated: "Elevated", highest: "Highest" };
  return map[raw] ?? raw;
}

/** Recova's "Stripe Radar" row: "42/100 - Normal". */
export function radarWords(score: number | null, level: string | null): string | null {
  if (score === null && !level) return null;
  return `${score ?? "?"}/100${level ? ` - ${humanRadarLevel(level)}` : ""}`;
}

/** The prior-charge and subscription columns are JSON; read them defensively. */
export function readPriorCharges(raw: unknown): PriorCharge[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is PriorCharge =>
      !!c && typeof c === "object" && typeof (c as PriorCharge).date === "string" && typeof (c as PriorCharge).amount === "number",
  );
}

export function readSubscription(raw: unknown): DisputeSubscription | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as DisputeSubscription;
  return typeof s.id === "string" && typeof s.status === "string" ? s : null;
}
