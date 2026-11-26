import { errorMessage } from "@dustinedwards/site-runtime/log";
import { askModel, REWRITE } from "~/lib/ai/client";
import { PLAIN_WRITING_PROMPT, retryStockPhrasing } from "~/lib/ai/plain-writing";
import { AUDIT_SUMMARY_MAX_TOKENS, MODEL_AUDIT_SUMMARY } from "~/lib/constants";

import type { AuditResult } from "./types";
import { AUDIT_SUMMARY_FALLBACK, buildAuditSummaryPrompt, sanitizeSummary } from "./summary";

// The audit summary's one call, through site-runtime's caller
// (~/lib/ai/client). Phase (c).
//
// NEVER THROWS INTO THE ENGINE.

export type AuditSummaryOutcome =
  | { source: "model"; summary: string }
  | { source: "fallback"; summary: string; reason: string };

export async function generateAuditSummary(
  env: Env,
  result: AuditResult,
): Promise<AuditSummaryOutcome> {
  if (!env.ANTHROPIC_API_KEY) {
    return {
      source: "fallback",
      summary: AUDIT_SUMMARY_FALLBACK,
      reason: "ANTHROPIC_API_KEY is not set",
    };
  }

  try {
    // The audit can run before any Foxhound account exists, so its cost row has
    // none.
    const prompt = `${buildAuditSummaryPrompt(result)}\n\n${PLAIN_WRITING_PROMPT}`;
    const call = async (instruction = ""): Promise<string> => {
      const answer = await askModel(
        env,
        { source: "audit_summary", accountId: null },
        {
          model: MODEL_AUDIT_SUMMARY,
          max_tokens: AUDIT_SUMMARY_MAX_TOKENS,
          messages: [{ role: "user", content: prompt + instruction }],
        },
        instruction ? REWRITE : {},
      );
      if (!answer.ok) throw new Error(`the model call failed: ${answer.kind}`);
      return sanitizeSummary(answer.text);
    };
    // One retry when the summary reads as machine-written
    // (ai/plain-writing.ts).
    const summary = await retryStockPhrasing(await call(), (text) => text, call);
    // An empty reply is a failure wearing a success.
    if (!summary) {
      return {
        source: "fallback",
        summary: AUDIT_SUMMARY_FALLBACK,
        reason: "the model returned no text",
      };
    }
    return { source: "model", summary };
  } catch (err) {
    // The message only: it names the failure's kind, never the prompt, which
    // carries this merchant's money.
    const detail = errorMessage(err);
    console.error("audit summary generation failed:", detail);
    return { source: "fallback", summary: AUDIT_SUMMARY_FALLBACK, reason: detail };
  }
}
