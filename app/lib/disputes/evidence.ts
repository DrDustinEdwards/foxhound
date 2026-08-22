import { createAnthropicClient } from "~/lib/ai/client";
import { MODEL_RECOVERY_EMAIL } from "~/lib/constants";
import { sanitizeCopy } from "~/lib/recovery/email-generation";

// AI dispute-evidence drafting (TASK-foxhound-dispute-intake.md deliverable 1).
// This is the liability core: evidence must be grounded ONLY in real records,
// never fabricated. The design makes fabrication structurally impossible for
// the deterministic fields (they are read straight off our own rows, never
// phrased by the model) and, for the one AI-composed field, impossible when
// there is nothing to ground it in: draftDisputeEvidence returns an empty
// array WITHOUT calling the model at all when there are no facts, so an empty
// input can never produce invented content, not merely a prompt asking the
// model not to invent it.

export interface CommunicationRecord {
  stepType: string;
  sentAt: Date;
  openedAt: Date | null;
  clickedAt: Date | null;
}

export interface EvidenceFacts {
  productName: string | null;
  serviceDate: Date | null;
  communications: CommunicationRecord[];
}

export interface FailedPaymentFacts {
  planName: string | null;
  subscriptionStart: Date | null;
  detectedAt: Date;
}

export interface RecoveryStepFacts {
  stepType: string;
  executedAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
}

/** Assemble grounding facts from real records only: the failed payment this
 *  charge recovered from (if any) and the recovery_steps that were actually
 *  executed. Pure. No record, no fact: a dispute on a charge with no matching
 *  recovery yields an empty EvidenceFacts. */
export function buildEvidenceFacts(
  failedPayment: FailedPaymentFacts | null,
  steps: RecoveryStepFacts[],
): EvidenceFacts {
  return {
    productName: failedPayment?.planName ?? null,
    serviceDate: failedPayment?.subscriptionStart ?? failedPayment?.detectedAt ?? null,
    communications: steps
      .filter((s): s is RecoveryStepFacts & { executedAt: Date } => s.executedAt != null)
      .map((s) => ({
        stepType: s.stepType,
        sentAt: s.executedAt,
        openedAt: s.openedAt,
        clickedAt: s.clickedAt,
      })),
  };
}

export function hasGroundingFacts(facts: EvidenceFacts): boolean {
  return facts.productName != null || facts.serviceDate != null || facts.communications.length > 0;
}

/** Deterministic (non-AI) evidence text built directly from real records. This
 *  is never phrased by the model, so it cannot be embellished or invented. */
export function formatCommunicationLog(communications: CommunicationRecord[]): string | null {
  if (communications.length === 0) return null;
  const lines = communications.map((c) => {
    const parts = [`${c.stepType} sent ${c.sentAt.toISOString().slice(0, 10)}`];
    if (c.openedAt) parts.push(`opened ${c.openedAt.toISOString().slice(0, 10)}`);
    if (c.clickedAt) parts.push(`clicked ${c.clickedAt.toISOString().slice(0, 10)}`);
    return parts.join(", ");
  });
  return lines.join("\n");
}

export interface EvidenceField {
  fieldName: string;
  fieldValue: string;
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    uncategorizedText: { type: "string" },
  },
  required: ["uncategorizedText"],
} as const;

function buildSystemPrompt(): string {
  return [
    "You write a short factual summary for a Stripe dispute evidence submission.",
    "You may state ONLY the facts given to you below. Never invent a date, an",
    "amount, an event, or any detail that is not explicitly provided. If the",
    "facts are sparse, write a short, honest summary using just what is given.",
    "Never use em dashes or en dashes. No corporate filler, no AI-sounding phrases.",
  ].join("\n");
}

function buildUserPrompt(facts: EvidenceFacts): string {
  const lines = ["Known facts about this transaction and customer contact:"];
  if (facts.productName) lines.push(`Product/plan: ${facts.productName}`);
  if (facts.serviceDate) {
    lines.push(`Service/subscription start: ${facts.serviceDate.toISOString().slice(0, 10)}`);
  }
  const log = formatCommunicationLog(facts.communications);
  if (log) lines.push(`Customer communication log:\n${log}`);
  lines.push("Summarize only the facts above in a few sentences for a dispute evidence submission.");
  return lines.join("\n\n");
}

/**
 * Draft the dispute evidence package, grounded only in real records.
 *
 * Structurally never fabricates: with no grounding facts at all, this returns
 * [] WITHOUT ever calling the model (not merely a prompt instruction). The
 * deterministic fields (product_description, service_date,
 * customer_communication) are read straight off the facts, never phrased by
 * the model. The model is used only to compose `uncategorized_text`, a short
 * narrative built strictly from the same facts, and only when there is at
 * least one fact to ground it in. A missing ANTHROPIC_API_KEY or a model-call
 * failure never blocks intake: the deterministic fields still land.
 */
export async function draftDisputeEvidence(env: Env, facts: EvidenceFacts): Promise<EvidenceField[]> {
  if (!hasGroundingFacts(facts)) return [];

  const fields: EvidenceField[] = [];
  if (facts.productName) {
    fields.push({ fieldName: "product_description", fieldValue: facts.productName });
  }
  if (facts.serviceDate) {
    fields.push({ fieldName: "service_date", fieldValue: facts.serviceDate.toISOString().slice(0, 10) });
  }
  const log = formatCommunicationLog(facts.communications);
  if (log) fields.push({ fieldName: "customer_communication", fieldValue: log });

  if (!env.ANTHROPIC_API_KEY) return fields;

  try {
    const client = createAnthropicClient(env);
    const response = await client.messages.create({
      model: MODEL_RECOVERY_EMAIL,
      max_tokens: 500,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserPrompt(facts) }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      const parsed = JSON.parse(textBlock.text) as { uncategorizedText: string };
      const clean = sanitizeCopy(parsed.uncategorizedText);
      if (clean.trim()) fields.push({ fieldName: "uncategorized_text", fieldValue: clean });
    }
  } catch {
    // AI drafting must never block dispute intake (mirrors recordOutcome's
    // never-throws posture): the deterministic fields above still land.
  }
  return fields;
}
