// The ai_calls cost map (closes legacy R-49: model-id drift + an incomplete cost
// map). ONE table, keyed by CANONICAL base model id, in USD cents per 1,000,000
// tokens. Every id in AI_MODEL_IDS must resolve here; an unknown model throws so a
// newly-wired model can never silently log $0 cost.
//
// Lookup normalizes a trailing -YYYYMMDD date suffix to the base id, so a dated
// alias (`claude-haiku-4-5-20251001`) and the canonical form (`claude-haiku-4-5`)
// map to the same entry. This is the structural defense against the exact drift
// R-49 named.

interface ModelCost {
  /** USD cents per 1,000,000 input tokens. */
  inputCentsPer1M: number;
  /** USD cents per 1,000,000 output tokens. */
  outputCentsPer1M: number;
}

// Standard list prices (not intro promos, which expire and would themselves drift).
const AI_MODEL_COSTS: Record<string, ModelCost> = {
  "claude-sonnet-5": { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  "claude-haiku-4-5": { inputCentsPer1M: 100, outputCentsPer1M: 500 },
};

/** Strip a trailing -YYYYMMDD snapshot suffix to the canonical base model id. Pure. */
function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** The cost entry for a model id (normalized). Throws on an uncovered model (R-49 guard). */
export function aiModelCost(model: string): ModelCost {
  const base = normalizeModelId(model);
  const cost = AI_MODEL_COSTS[base];
  if (!cost) {
    throw new Error(`no ai_calls cost entry for model '${model}' (normalized '${base}')`);
  }
  return cost;
}

/**
 * Cost of one AI call in whole USD cents, rounded UP. Pure.
 *
 * `ceil`, not `round`, restored by parity CHUNKS item 17 (named by its numbering per 291, not
 * volume ruling 17). Legacy named this a
 * no-undercount accounting policy and the rebuild reversed it silently: a
 * Pass 4 git-blame check found this line authored at file creation, in a commit
 * about model-id drift, so there was never a decision to reverse the policy.
 *
 * The direction matters more than the per-call cent. Sub-cent calls are the
 * common case here (a 2000-token dunning generation costs well under a cent),
 * and `round` sends every one of those to zero, so a systematic undercount
 * compounds silently across thousands of calls and cost tracking reads clean
 * while real spend climbs. Rounding up is wrong by at most a cent per call and
 * wrong in the safe direction.
 */
export function computeAiCallCostCents(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const cost = aiModelCost(model);
  const cents =
    (promptTokens / 1_000_000) * cost.inputCentsPer1M +
    (completionTokens / 1_000_000) * cost.outputCentsPer1M;
  return Math.ceil(cents);
}
