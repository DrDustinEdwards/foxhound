import { costMicros } from "@dustinedwards/site-runtime/ai-engine";

import type { Db } from "~/db";
import { aiCalls } from "~/db";

// The ai_calls cost (closes legacy R-49: model-id drift and an incomplete cost map). The prices are
// site-runtime's PRICES and costMicros, the network's one table, read from Anthropic's pricing page; never a copy here
// (Foxhound's own table once had Sonnet 5 at $3/$15 when the list price is $2/$10). costMicros matches a dated
// id (`claude-haiku-4-5-20251001`) and its base form alike, and an unpriced model throws, so a newly wired
// model can never silently log $0.

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
  const micros = costMicros(model, {
    input: promptTokens,
    output: completionTokens,
    cacheRead: 0,
    cacheWrite: 0,
  });
  if (micros === null)
    throw new Error(`no ai_calls price for model '${model}' in site-runtime PRICES`);
  // 10,000 millionths of a dollar are a cent.
  return Math.ceil(micros / 10_000);
}

/** Insert one ai_calls row with its computed cost. Operational (not a money write). */
export function buildAiCallRow(
  db: Db,
  input: {
    accountId: string | null;
    source: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    relatedId?: string | null;
    createdAt: Date;
  },
) {
  return db.insert(aiCalls).values({
    accountId: input.accountId,
    source: input.source,
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    costCents: computeAiCallCostCents(input.model, input.promptTokens, input.completionTokens),
    relatedId: input.relatedId ?? null,
    createdAt: input.createdAt,
  });
}
