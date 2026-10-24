import { createAnthropicClient } from "~/lib/ai/client";
import { UNTRUSTED_DATA_RULE, untrusted } from "~/lib/ai/untrusted";
import { MODEL_INTELLIGENCE_NARRATIVE } from "~/lib/constants";
import { formatMoney } from "~/lib/money-format";
import { sanitizeCopy } from "~/lib/recovery/email-generation";

// The Intelligence nightly AI analyst narrative (PRICING.md: "nightly AI
// analyst narrative", the one AI call in the paid layer). Mirrors
// app/lib/recovery/email-generation.ts's seam shape exactly: a per-call
// Anthropic client, Sonnet 5, thinking disabled, json_schema structured
// output, brand sanitizers. STRUCTURAL non-fabrication, the same discipline
// as app/lib/disputes/evidence.ts: with no facts to narrate, this returns a
// short honest message WITHOUT ever calling the model. Every number and
// customer in the prompt is a real value the caller (ai-run.server.ts)
// computed from customer_context / mrr_snapshots / risk.ts; the model only
// phrases them, it never sources one. Free text can still embellish around a
// real number in prose (unlike evidence.ts's deterministic fields, this call
// has no non-AI fallback for the narrative itself); the system prompt forbids
// it explicitly, the same defense generateDunningEmail and
// draftDisputeEvidence rely on, and the response is further filtered to only
// accept customerAssessments for stripeCustomerIds that were actually in the
// input list (a hallucinated id is dropped, never surfaced).

export interface AtRiskCustomerFact {
  stripeCustomerId: string;
  customerName: string | null;
  healthScore: number;
  mrrContributionCents: number;
  currency: string;
  factorDetails: string[];
}

export interface NarrativeFacts {
  accountName: string;
  currency: string;
  totalMrrCents: number;
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
  reactivationMrrCents: number;
  mrrAtRiskCents: number;
  atRiskCustomerCount: number;
  /** Already capped to the top-N by the caller (INTELLIGENCE_NARRATIVE_TOP_N). */
  topAtRiskCustomers: AtRiskCustomerFact[];
}

/** True when there is anything real to narrate. A brand-new account with no
 *  MRR and no at-risk customers has nothing to say yet: an honest empty state
 *  (DESIGN.md), not a reason to fabricate a narrative. */
export function hasNarrativeFacts(facts: NarrativeFacts): boolean {
  return facts.totalMrrCents > 0 || facts.topAtRiskCustomers.length > 0;
}

export const NOT_ENOUGH_DATA_NARRATIVE =
  "Not enough data yet for a narrative. Once a full billing cycle has synced, this report will summarize MRR movement and the customers most at risk.";

export interface NarrativeCustomerAssessment {
  stripeCustomerId: string;
  assessment: string;
}

export interface NarrativeResult {
  narrative: string;
  customerAssessments: NarrativeCustomerAssessment[];
  /** null when no model call was made (the no-facts short circuit). */
  usage: { promptTokens: number; completionTokens: number } | null;
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    narrative: { type: "string" },
    customerAssessments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          stripeCustomerId: { type: "string" },
          assessment: { type: "string" },
        },
        required: ["stripeCustomerId", "assessment"],
      },
    },
  },
  required: ["narrative", "customerAssessments"],
} as const;

function buildSystemPrompt(): string {
  return [
    "You are an AI analyst writing a short revenue-risk narrative for a",
    "subscription business, and one-sentence assessments for its most at-risk",
    "customers.",
    "You may state ONLY the facts given to you below. Never invent a number, a",
    "customer name, a trend, or a cause that is not explicitly provided. If you",
    "are unsure why a customer is at risk, describe the factor given rather than",
    "guessing a reason.",
    "Only write a customerAssessments entry for a stripeCustomerId that appears",
    "in the list given to you; never invent or reference any other customer.",
    "Never use em dashes or en dashes. No corporate filler, no AI-sounding",
    "phrases, no 'I hope this finds you well'.",
    UNTRUSTED_DATA_RULE,
  ].join("\n");
}

function buildUserPrompt(facts: NarrativeFacts): string {
  const lines = [
    `Business: ${untrusted(facts.accountName)}`,
    `Total MRR: ${formatMoney(facts.totalMrrCents, facts.currency)}`,
    `MRR movement this period: new ${formatMoney(facts.newMrrCents, facts.currency)}, ` +
      `expansion ${formatMoney(facts.expansionMrrCents, facts.currency)}, ` +
      `contraction ${formatMoney(facts.contractionMrrCents, facts.currency)}, ` +
      `churn ${formatMoney(facts.churnMrrCents, facts.currency)}, ` +
      `reactivation ${formatMoney(facts.reactivationMrrCents, facts.currency)}`,
    `MRR at risk: ${formatMoney(facts.mrrAtRiskCents, facts.currency)} across ${facts.atRiskCustomerCount} customer(s)`,
  ];
  if (facts.topAtRiskCustomers.length > 0) {
    lines.push("Most at-risk customers:");
    for (const c of facts.topAtRiskCustomers) {
      const name = c.customerName ? untrusted(c.customerName) : c.stripeCustomerId;
      const factorText =
        c.factorDetails.length > 0 ? c.factorDetails.join("; ") : "no specific factors on record";
      lines.push(
        `- ${name} (id ${c.stripeCustomerId}): health score ${c.healthScore}/100, ` +
          `${formatMoney(c.mrrContributionCents, c.currency)} MRR. Factors: ${factorText}`,
      );
    }
  }
  lines.push(
    "Write a short narrative (2-4 sentences) summarizing the MRR movement and",
    "revenue risk above. Then write one brief assessment sentence for each",
    "listed at-risk customer, using only their given factors.",
  );
  return lines.join("\n");
}

/**
 * Generate the nightly Intelligence narrative + per-customer assessments.
 * Structurally never fabricates: with no facts at all, returns a fixed
 * honest message WITHOUT calling the model (mirrors evidence.ts returning []
 * on no grounding). Throws if ANTHROPIC_API_KEY is unset AND there are facts
 * to narrate (mirrors generateDunningEmail's unconditional throw); the
 * caller (ai-run.server.ts) is responsible for the fail-safe catch so a
 * missing/unfunded key never blocks the deterministic score/prediction/alert
 * writes.
 */
export async function generateIntelligenceNarrative(
  env: Env,
  facts: NarrativeFacts,
): Promise<NarrativeResult> {
  if (!hasNarrativeFacts(facts)) {
    return { narrative: NOT_ENOUGH_DATA_NARRATIVE, customerAssessments: [], usage: null };
  }
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const client = createAnthropicClient(env);

  const response = await client.messages.create({
    model: MODEL_INTELLIGENCE_NARRATIVE,
    max_tokens: 2000,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserPrompt(facts) }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("intelligence narrative generation returned no text block");
  }
  const parsed = JSON.parse(textBlock.text) as {
    narrative: string;
    customerAssessments: { stripeCustomerId: string; assessment: string }[];
  };

  const allowedIds = new Set(facts.topAtRiskCustomers.map((c) => c.stripeCustomerId));
  const customerAssessments = parsed.customerAssessments
    .filter((a) => allowedIds.has(a.stripeCustomerId))
    .map((a) => ({ stripeCustomerId: a.stripeCustomerId, assessment: sanitizeCopy(a.assessment) }));

  return {
    narrative: sanitizeCopy(parsed.narrative),
    customerAssessments,
    usage: {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    },
  };
}
