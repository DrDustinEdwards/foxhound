import type Stripe from "stripe";

import { STRIPE_FILE_SLOTS, type EvidenceFileUpload } from "~/lib/disputes/evidence-files";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

// Dispute evidence submission.
// The ONLY place stripe.disputes.update is called.

// The known Stripe dispute-evidence field names (mirrors
// Stripe.DisputeUpdateParams.Evidence). An explicit allow-list means a stray or
// unexpected dispute_evidence.field_name can never leak into the Stripe
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

/**
 * Map dispute_evidence rows (fieldName/fieldValue, the merchant-approved
 * package) to Stripe's evidence object. Pure. Blank values and any field name
 * outside the known Stripe evidence vocabulary are dropped rather than sent.
 */
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

async function uploadEvidenceFilesToStripe(
  stripe: Stripe,
  files: EvidenceFileUpload[],
): Promise<Record<string, string>> {
  const slots: Record<string, string> = {};
  for (let i = 0; i < files.length && i < STRIPE_FILE_SLOTS.length; i++) {
    const file = files[i]!;
    try {
      const created = await stripe.files.create(
        {
          purpose: "dispute_evidence",
          file: { data: file.bytes, name: file.name, type: file.contentType },
        },
        { timeout: 60_000 },
      ); // evidence files are larger than the 30 s client default allows
      const slot = STRIPE_FILE_SLOTS[file.slot ?? i];
      if (slot) slots[slot] = created.id;
    } catch (error) {
      console.error("dispute evidence file upload to Stripe failed", { name: file.name }, error);
    }
  }
  return slots;
}

/** Submit the merchant-approved evidence to Stripe and request immediate submission to the bank (`submit: true`; never staged-only). Isolated so a fake Stripe client can drive it in tests. */
export async function submitDisputeEvidenceWithClient(
  stripe: Stripe,
  ctx: {
    stripeDisputeId: string;
    evidence: Stripe.DisputeUpdateParams.Evidence;
    files?: EvidenceFileUpload[];
  },
): Promise<DisputeSubmissionResult> {
  try {
    const fileSlots =
      ctx.files && ctx.files.length > 0 ? await uploadEvidenceFilesToStripe(stripe, ctx.files) : {};
    const evidence = { ...ctx.evidence, ...fileSlots } as Stripe.DisputeUpdateParams.Evidence;
    await stripe.disputes.update(ctx.stripeDisputeId, { evidence, submit: true });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Stripe dispute submission failed",
    };
  }
}

/** Whether Stripe already holds an evidence submission for the dispute (evidence_details.submission_count). */
export async function disputeSubmittedAtStripe(
  env: Env,
  ctx: { stripeDisputeId: string; connectionAccessToken: string },
): Promise<boolean> {
  const stripe = getConnectedStripe(await decryptToken(env, ctx.connectionAccessToken));
  const dispute = await stripe.disputes.retrieve(ctx.stripeDisputeId);
  return (dispute.evidence_details?.submission_count ?? 0) > 0;
}

export interface DisputeSubmissionContext {
  stripeDisputeId: string;
  /**
   * Encrypted stripe_connections.stripe_access_token for the connected account.
   */
  connectionAccessToken: string;
  evidence: Stripe.DisputeUpdateParams.Evidence;
  /** The merchant's evidence files, read from the EVIDENCE bucket. */
  files?: EvidenceFileUpload[];
}

/**
 * Default IO: decrypt the connection token, build the connected client, submit.
 * Never logs the token (ARCHITECTURE.md non-negotiable #5).
 */
export async function submitDisputeEvidence(
  env: Env,
  ctx: DisputeSubmissionContext,
): Promise<DisputeSubmissionResult> {
  const token = await decryptToken(env, ctx.connectionAccessToken);
  const stripe = getConnectedStripe(token);
  return submitDisputeEvidenceWithClient(stripe, ctx);
}
