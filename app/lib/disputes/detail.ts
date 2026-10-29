import { DISPUTE_FEE_BPS, DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { EVIDENCE_FILE_FIELD } from "~/lib/disputes/evidence-files";
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

/** Recova's three shipping inputs (DisputeDetailClient.tsx, shown when the
 *  account ships physical goods, S32), as the Stripe evidence fields they are
 *  submitted in. Recova kept them in disputes.shipping_* and copied them into
 *  the evidence at submit; Foxhound saves them as evidence with the draft. */
export const SHIPPING_TRACKING_FIELD = "shipping_tracking_number";
export const SHIPPING_CARRIER_FIELD = "shipping_carrier";
export const SHIPPING_DATE_FIELD = "shipping_date";
export const SHIPPING_FIELDS = [SHIPPING_TRACKING_FIELD, SHIPPING_CARRIER_FIELD, SHIPPING_DATE_FIELD] as const;

/** Recova's carrier select, in its order. */
export const SHIPPING_CARRIERS = ["UPS", "FedEx", "USPS", "DHL", "Other"] as const;

/** Accept's confirmation line (DisputeActionBar.tsx), with Foxhound's name. */
export const ACCEPT_CONFIRM_LINE = "Accept this dispute? You won't be charged a Foxhound fee.";
/** Shown in Accept's place while an approval stands (PR 149 review). Not
 *  Recova's: Recova offered Accept until submission. Listed for Dustin. */
export const ACCEPT_UNAVAILABLE_APPROVED_LINE = "Accept is not available once the evidence has been approved for submission.";

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
  if (state === "inquiry_closed") return "Inquiry closed";
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
 * it is not shown twice, and the same holds for the shipping fields while their
 * inputs are on screen.
 */
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
    // A merchant's uploaded file has its own section, Evidence files (J07).
    .filter((e) => e.fieldName !== EVIDENCE_FILE_FIELD)
    .filter((e) => !(ipEditable && e.fieldName === CUSTOMER_IP_FIELD))
    .filter((e) => !(shippingEditable && (SHIPPING_FIELDS as readonly string[]).includes(e.fieldName)))
    .filter((e) => e.fieldValue.trim() !== "");
  return { structured, narrative, customerIp, shipping };
}

/** The fee terms on the approve card, read from the billing constants rather
 *  than typed (RULES.md 2.1). */
export function disputeFeeTerms(): string {
  const pct = DISPUTE_FEE_BPS / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}% of the disputed amount, capped at ${formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")}`;
}

/**
 * Unsaved-edit tracking for the draft (J77 review). Approve submits the SAVED
 * draft, so while the page holds edits the save has not taken, Approve is
 * held back. Counters rather than a flag: an edit typed while a save is in
 * flight is not covered by that save, so it stays unsaved.
 */
export interface DraftState {
  /** Edits made on the page. */
  edits: number;
  /** The edit count when the last save was sent. */
  submitted: number;
  /** The edit count the last successful save covered. */
  saved: number;
}

export type DraftEvent = { type: "edit" } | { type: "submit" } | { type: "saved" };

export function draftAfter(state: DraftState, event: DraftEvent): DraftState {
  if (event.type === "edit") return { ...state, edits: state.edits + 1 };
  if (event.type === "submit") return { ...state, submitted: state.edits };
  return { ...state, saved: state.submitted };
}

export function draftDirty(state: DraftState): boolean {
  return state.edits !== state.saved;
}

/** The line beside a held-back Approve. */
export const UNSAVED_APPROVE_LINE = "You have unsaved changes. Save your draft first: Approve submits the saved draft.";
