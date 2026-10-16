import type Stripe from "stripe";

import { STRIPE_FILE_SLOTS, type EvidenceFileUpload } from "~/lib/disputes/evidence-files";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

// Dispute evidence submission (TASK-foxhound-dispute-intake.md deliverable 2).
// The ONLY place stripe.disputes.update is called. It is reached exclusively
// from the merchant's explicit approve action (app/lib/disputes/approval.ts
// approveAndSubmit + app/routes/app/disputes/detail.tsx), never from a cron or
// any automatic path: there is no auto-submit, even at the evidence deadline
// (PRICING.md hard rule).

// The known Stripe dispute-evidence field names (mirrors
// Stripe.DisputeUpdateParams.Evidence). An explicit allow-list means a stray
// or unexpected dispute_evidence.field_name can never leak into the Stripe
// evidence payload.
const STRIPE_EVIDENCE_FIELDS = [
  "access_activity_log",
  "billing_address",
  "cancellation_policy_disclosure",
  "cancellation_rebuttal",
  "customer_communication",
  "customer_email_address",
  "customer_name",
  "customer_purchase_ip",
  "duplicate_charge_explanation",
  "duplicate_charge_id",
  "product_description",
  "refund_policy_disclosure",
  "refund_refusal_explanation",
  "service_date",
  "shipping_address",
  "shipping_carrier",
  "shipping_date",
  "shipping_tracking_number",
  "uncategorized_text",
] as const;
type StripeEvidenceField = (typeof STRIPE_EVIDENCE_FIELDS)[number];

function isStripeEvidenceField(name: string): name is StripeEvidenceField {
  return (STRIPE_EVIDENCE_FIELDS as readonly string[]).includes(name);
}

/** Map dispute_evidence rows (fieldName/fieldValue, the merchant-approved
 *  package) to Stripe's evidence object. Pure. Blank values and any field name
 *  outside the known Stripe evidence vocabulary are dropped rather than sent.
 *  If a field has two rows, the FIRST one in the given order decides (blank
 *  included), the same row the dispute page shows and its draft save edits
 *  (getDisputeDetail reads them oldest first). */
export function buildStripeEvidencePayload(
  rows: { fieldName: string; fieldValue: string }[],
): Stripe.DisputeUpdateParams.Evidence {
  const evidence: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.fieldName)) continue;
    seen.add(row.fieldName);
    if (row.fieldValue.trim() && isStripeEvidenceField(row.fieldName)) {
      evidence[row.fieldName] = row.fieldValue;
    }
  }
  return evidence as Stripe.DisputeUpdateParams.Evidence;
}

export type DisputeSubmissionResult = { ok: true } | { ok: false; error: string };

/**
 * Upload the merchant's evidence files to Stripe (purpose dispute_evidence) and
 * return the file ids by evidence slot, in Recova's slot order (submit/route.ts
 * FILE_SLOTS). As Recova's, a file Stripe refuses is logged and left out, and
 * the submission goes on without it.
 */
async function uploadEvidenceFilesToStripe(
  stripe: Stripe,
  files: EvidenceFileUpload[],
): Promise<Record<string, string>> {
  const slots: Record<string, string> = {};
  for (let i = 0; i < files.length && i < STRIPE_FILE_SLOTS.length; i++) {
    const file = files[i]!;
    try {
      const created = await stripe.files.create({
        purpose: "dispute_evidence",
        file: { data: file.bytes, name: file.name, type: file.contentType },
      });
      const slot = STRIPE_FILE_SLOTS[file.slot ?? i];
      if (slot) slots[slot] = created.id;
    } catch (error) {
      console.error("dispute evidence file upload to Stripe failed", { name: file.name }, error);
    }
  }
  return slots;
}

/** Submit the merchant-approved evidence to Stripe and request immediate
 *  submission to the bank (`submit: true`; never staged-only). Isolated so a
 *  fake Stripe client can drive it in tests without a live call, mirroring
 *  app/lib/engine/execute-step.ts's payInvoiceWithClient. The merchant's files
 *  (J07) go up first and take their slots; as in Recova's submit route, a file
 *  outranks a text field of the same name. */
export async function submitDisputeEvidenceWithClient(
  stripe: Stripe,
  ctx: { stripeDisputeId: string; evidence: Stripe.DisputeUpdateParams.Evidence; files?: EvidenceFileUpload[] },
): Promise<DisputeSubmissionResult> {
  try {
    const fileSlots = ctx.files && ctx.files.length > 0 ? await uploadEvidenceFilesToStripe(stripe, ctx.files) : {};
    const evidence = { ...ctx.evidence, ...fileSlots } as Stripe.DisputeUpdateParams.Evidence;
    await stripe.disputes.update(ctx.stripeDisputeId, { evidence, submit: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Stripe dispute submission failed" };
  }
}

export interface DisputeSubmissionContext {
  stripeDisputeId: string;
  /** Encrypted stripe_connections.stripe_access_token for the connected account. */
  connectionAccessToken: string;
  evidence: Stripe.DisputeUpdateParams.Evidence;
  /** The merchant's evidence files, read from the EVIDENCE bucket (J07). */
  files?: EvidenceFileUpload[];
}

/** Default IO: decrypt the connection token, build the connected client,
 *  submit. Never logs the token (ARCHITECTURE.md non-negotiable #5). */
export async function submitDisputeEvidence(
  env: Env,
  ctx: DisputeSubmissionContext,
): Promise<DisputeSubmissionResult> {
  const token = await decryptToken(env, ctx.connectionAccessToken);
  const stripe = getConnectedStripe(token);
  return submitDisputeEvidenceWithClient(stripe, ctx);
}
