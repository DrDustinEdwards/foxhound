import { humanize } from "@drdustinedwards/site-helpers/text";
import { DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { EVIDENCE_FILE_FIELD } from "~/lib/disputes/evidence-files";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";

// Pure pieces of /disputes/:id, client-safe: no database, no Stripe.

export const BACK_LINK_REAL = { href: "/disputes/dashboard", label: "Back to disputes" };
export const BACK_LINK_DEMO = { href: "/disputes/dashboard", label: "All disputes" };

export const NARRATIVE_FIELD = "uncategorized_text";
export const CUSTOMER_IP_FIELD = "customer_purchase_ip";

export const SHIPPING_TRACKING_FIELD = "shipping_tracking_number";
export const SHIPPING_CARRIER_FIELD = "shipping_carrier";
export const SHIPPING_DATE_FIELD = "shipping_date";
export const SHIPPING_FIELDS = [
  SHIPPING_TRACKING_FIELD,
  SHIPPING_CARRIER_FIELD,
  SHIPPING_DATE_FIELD,
] as const;

export const SHIPPING_CARRIERS = ["UPS", "FedEx", "USPS", "DHL", "Other"] as const;

/** Accept's confirmation line (DisputeActionBar.tsx), with Foxhound's name. */
export const ACCEPT_CONFIRM_LINE = "Accept this dispute? You won't be charged a Foxhound fee.";
/** Shown in Accept's place while an approval stands. Listed for Dustin. */
export const ACCEPT_UNAVAILABLE_APPROVED_LINE =
  "Accept is not available once the evidence has been approved for submission.";

export function deadlineRemaining(days: number | null): string {
  if (days === null) return "No deadline set";
  if (days <= 0) return "Deadline passed";
  if (days === 1) return "1 day remaining";
  return `${days} days remaining`;
}

export function outcomeWord(state: string): string | null {
  if (state === "resolved_won") return "Won";
  if (state === "resolved_lost") return "Lost";
  if (state === "inquiry_closed") return "Inquiry closed";
  return null;
}

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
  return EVIDENCE_FIELD_LABELS[fieldName] ?? humanize(fieldName);
}

export interface EvidenceRowLike {
  id: string;
  fieldName: string;
  fieldValue: string;
}

export function splitEvidence(
  evidence: EvidenceRowLike[],
  ipEditable: boolean,
  shippingEditable = false,
): {
  structured: EvidenceRowLike[];
  narrative: string;
  customerIp: string;
  shipping: Record<(typeof SHIPPING_FIELDS)[number], string>;
} {
  const value = (name: string) => evidence.find((e) => e.fieldName === name)?.fieldValue ?? "";
  const narrative = value(NARRATIVE_FIELD);
  const customerIp = value(CUSTOMER_IP_FIELD);
  const shipping = {
    [SHIPPING_TRACKING_FIELD]: value(SHIPPING_TRACKING_FIELD),
    [SHIPPING_CARRIER_FIELD]: value(SHIPPING_CARRIER_FIELD),
    [SHIPPING_DATE_FIELD]: value(SHIPPING_DATE_FIELD),
  } as Record<(typeof SHIPPING_FIELDS)[number], string>;
  const structured = evidence
    .filter((e) => e.fieldName !== NARRATIVE_FIELD)
    // A merchant's uploaded file has its own section, Evidence files.
    .filter((e) => e.fieldName !== EVIDENCE_FILE_FIELD)
    .filter((e) => !(ipEditable && e.fieldName === CUSTOMER_IP_FIELD))
    .filter(
      (e) => !(shippingEditable && (SHIPPING_FIELDS as readonly string[]).includes(e.fieldName)),
    )
    .filter((e) => e.fieldValue.trim() !== "");
  return { structured, narrative, customerIp, shipping };
}

/**
 * The fee terms on the approve card, read from the billing constants rather
 * than typed.
 */
export function disputeFeeTerms(): string {
  const pct = DISPUTE_FEE_BPS / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}% of the disputed amount, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")}`;
}

/** The line beside a held-back Approve. */
export const UNSAVED_APPROVE_LINE =
  "You have unsaved changes. Save your draft first: Approve submits the saved draft.";
