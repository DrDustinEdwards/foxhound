import { costMicros } from "@dustinedwards/site-runtime/ai-engine";

import type { Db } from "~/db";
import { aiCalls } from "~/db";

/** Cost of one AI call in whole USD cents, rounded UP. Pure. */
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

/**
 * Insert one ai_calls row with its computed cost. Operational (not a money
 * write).
 */
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
