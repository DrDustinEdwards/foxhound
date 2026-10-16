import { DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { formatMoneyShort } from "~/lib/money-format";

// Pure pieces of /disputes/:id (J77, row S14), client-safe: no database, no
// Stripe. Recova is the spec: app/(app)/disputes/[id]/DisputeDetailClient.tsx
// (blob 3d56b55d) and components/disputes/formatters.tsx (81bf7f8b).

/** Recova's back link, DisputeDetailClient.tsx: "Back to disputes" to the
 *  disputes dashboard, and "All disputes" in the demo. Foxhound's demo opens
 *  the real list, so both go to the same page. */
export const BACK_LINK_REAL = { href: "/disputes/dashboard", label: "Back to disputes" };
export const BACK_LINK_DEMO = { href: "/disputes/dashboard", label: "All disputes" };

/** The Stripe evidence field that holds Recova's editable narrative. */
export const NARRATIVE_FIELD = "uncategorized_text";
/** The Stripe evidence field that holds Recova's "Customer IP". */
export const CUSTOMER_IP_FIELD = "customer_purchase_ip";

/**
 * The header's deadline line, in Recova's words: "No deadline set",
 * "Deadline passed", or "N days remaining". Recova printed "1 days remaining";
 * one day reads "1 day remaining".
 */
export function deadlineRemaining(days: number | null): string {
  if (days === null) return "No deadline set";
  if (days <= 0) return "Deadline passed";
  if (days === 1) return "1 day remaining";
  return `${days} days remaining`;
}

/** The outcome badge Recova shows once a dispute is closed. */
export function outcomeWord(state: string): string | null {
  if (state === "resolved_won") return "Won";
  if (state === "resolved_lost") return "Lost";
  return null;
}

/** Stripe's evidence field names, as a merchant should read them: Recova's
 *  fieldLabel map, with the other names Foxhound can hold in sentence case. */
const EVIDENCE_FIELD_LABELS: Record<string, string> = {
  billing_address: "Billing address",
  cancellation_policy_disclosure: "Cancellation policy disclosure",
  customer_communication: "Customer communication",
  customer_email_address: "Customer email",
  customer_name: "Customer name",
  customer_purchase_ip: "Purchase IP",
  duplicate_charge_explanation: "Duplicate charge explanation",
  product_description: "Product description",
  refund_policy_disclosure: "Refund policy disclosure",
  service_date: "Service date",
  service_documentation: "Service documentation",
  shipping_address: "Shipping address",
  shipping_carrier: "Shipping carrier",
  shipping_date: "Ship date",
  shipping_tracking_number: "Tracking number",
  subscription_information: "Subscription",
};

export function evidenceFieldLabel(fieldName: string): string {
  const mapped = EVIDENCE_FIELD_LABELS[fieldName];
  if (mapped) return mapped;
  const spaced = fieldName.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface EvidenceRowLike {
  id: string;
  fieldName: string;
  fieldValue: string;
}

/**
 * Recova's "Staged evidence" split: every structured field as a read-only row
 * except the narrative, which is the editable textarea. While the "Additional
 * evidence" Customer IP box is on screen, the IP row is left out of the list so
 * it is not shown twice.
 */
export function splitEvidence(
  evidence: EvidenceRowLike[],
  ipEditable: boolean,
): { structured: EvidenceRowLike[]; narrative: string; customerIp: string } {
  const narrative = evidence.find((e) => e.fieldName === NARRATIVE_FIELD)?.fieldValue ?? "";
  const customerIp = evidence.find((e) => e.fieldName === CUSTOMER_IP_FIELD)?.fieldValue ?? "";
  const structured = evidence
    .filter((e) => e.fieldName !== NARRATIVE_FIELD)
    .filter((e) => !(ipEditable && e.fieldName === CUSTOMER_IP_FIELD))
    .filter((e) => e.fieldValue.trim() !== "");
  return { structured, narrative, customerIp };
}

/** The fee terms on the approve card, read from the billing constants rather
 *  than typed (RULES.md 2.1). */
export function disputeFeeTerms(): string {
  const pct = DISPUTE_FEE_BPS / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}% of the disputed amount, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")}`;
}
