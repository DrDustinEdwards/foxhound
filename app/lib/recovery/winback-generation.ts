import { createAnthropicClient } from "~/lib/ai/client";
import { MODEL_RECOVERY_EMAIL } from "~/lib/constants";

import { applyTimingWordGuard, readGeneratedCopy, type EmailCopy } from "./email-generation";

// THE WIN-BACK AI HALF. Ported from legacy's inline generation in
// app/api/cron/process-winback/route.ts (blob `18f20de9`, 24,184 bytes,
// lines 288 and 340 to 400). This is 346's REMAINING item: session 52 shipped
// the template half and named this as work rather than hiding it in a green
// suite.
//
// IT IS A SEPARATE BUILDER, NOT THE DUNNING SCAFFOLD. Legacy builds one USER
// message string here with NO system prompt, where the dunning path sends
// `EMAIL_SYSTEM_PROMPT` plus `buildEmailUserMessage`. Nothing is shared between
// them on either side, so `buildPrompts` is untouched.
//
// THE VOICE IS THE GENERAL ONE, AND ONLY THAT. Legacy's merchant select here is
// `brand_voice, sender_name, reply_to_email` (line 288): no per-category
// columns, so `resolveBrandVoice` and its decline-category argument are NOT
// used. That is correct rather than an oversight, and the reason is in the
// domain: RECOVERY_SCHEDULES' six keys are DECLINE categories, and a
// cancellation is not a decline, so a win-back has no category to resolve.
//
// MERCHANT CONTEXT IS NOT INCLUDED, because legacy does not include it. The
// industry, customer type and MRR that 337's reader feeds the DUNNING prompt
// appear nowhere in legacy's win-back prompt or its select.

/** Legacy's per-step descriptions, verbatim, including the tone each carries.
 *  Step 3 is the "last chance, no pressure" line the brief asks about. */
const STEP_DESCRIPTIONS: Record<number, string> = {
  1: "first win-back email sent 1 hour after cancellation, warm, empathetic, not pushy",
  2: "second win-back email sent 4 days after cancellation, share value, mention improvements",
  3: "final win-back email sent 14 days after cancellation, last chance, no pressure",
};

/** Legacy's `${merchant.brand_voice || 'friendly and conversational'}`.
 *
 *  NOT `BRAND_VOICE_DEFAULT`. 338 aligned the DUNNING default to legacy's
 *  constant ("Friendly and direct. Write like a real person, not a company."),
 *  and legacy's win-back prompt carries a DIFFERENT literal. Ported as found
 *  rather than unified, because the two are legacy's own two strings. */
export const WINBACK_VOICE_FALLBACK = "friendly and conversational";

export interface WinbackPromptInput {
  stepNumber: number;
  customerName: string;
  planName: string;
  cancelReason: string | null;
  /** `stripe_connections.brand_voice`, the general voice. */
  brandVoice: string | null;
  senderName: string;
  resubscribeUrl: string;
}

/**
 * Legacy's prompt, verbatim in wording and order, with one omission and one
 * addition.
 *
 * THE OMISSION, forced: legacy's "Button style:" line inlines hex from its
 * EMAIL_COLORS module, and check-tokens fails the build on raw hex. The line is
 * dropped rather than recoloured, because a style instruction naming colours
 * Foxhound does not have would ask the model for the wrong thing.
 *
 * THE ADDITION, job J01: the timing-word requirement line. Legacy's win-back
 * gets that rule from its Haiku quality-check prompt (lib/email-generation.ts
 * blob `e28d780e` line 344), a second pass Foxhound does not have, so this
 * prompt is the only place the rule can live. It names the same nine phrases
 * as the detector. Every other line is legacy's.
 *
 * Pure, so a plant reads the real prompt bytes rather than a rebuilt copy
 * (337 binding 4).
 */
export function buildWinbackPrompt(input: WinbackPromptInput): string {
  const description = STEP_DESCRIPTIONS[input.stepNumber] ?? "win-back email";
  return [
    "You are writing a win-back email for a SaaS business trying to re-engage a cancelled customer.",
    "",
    `This is a ${description}.`,
    "",
    "Customer details:",
    `- Name: ${input.customerName}`,
    `- Cancelled plan: ${input.planName}`,
    `- Cancellation reason: ${input.cancelReason || "not provided"}`,
    "",
    "Email requirements:",
    `- Brand voice: ${input.brandVoice || WINBACK_VOICE_FALLBACK}`,
    "- Keep it under 120 words",
    `- Include a reactivation button linking to: ${input.resubscribeUrl}`,
    `- Sender name: ${input.senderName}`,
    "- Do NOT be desperate or salesy, be genuine",
    "- Never use timing words like 'today', 'tonight', 'yesterday', 'this morning', 'this afternoon', 'this evening', 'right now', 'immediately' or 'by end of day' in the subject or the body, you do not know when the customer will read this",
    "",
    "Respond ONLY in this exact JSON format with no preamble or markdown:",
    '{"subject":"<email subject line>","body":"<full HTML email body>"}',
  ].join("\n");
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    bodyHtml: { type: "string" },
  },
  required: ["subject", "bodyHtml"],
  additionalProperties: false,
} as const;

/**
 * Generate one win-back email.
 *
 * THE CLIENT COMES FROM THE FACTORY (347). This is the FIFTH call site, and it
 * constructs nothing of its own, so the gateway base URL and the
 * no-body-log header apply here exactly as they do to the other four.
 *
 * The model is `MODEL_RECOVERY_EMAIL`, the same constant the dunning generator
 * uses. Legacy pins `MODEL_PRIMARY`, `claude-sonnet-4-5`; Foxhound's equivalent
 * surface has been on `claude-sonnet-5` since the dunning generator shipped, and
 * reintroducing legacy's older pin for this one call would make Foxhound
 * disagree with itself. `max_tokens` IS legacy's own 1000 for this call, which
 * differs from the dunning path's 2000.
 */
export async function generateWinbackEmail(
  env: Env,
  input: WinbackPromptInput,
): Promise<EmailCopy> {
  const client = createAnthropicClient(env);
  const prompt = buildWinbackPrompt(input);

  // One call shape for the first call and the timing-word retry: the retry is
  // the same prompt with legacy's instruction appended.
  const call = async (instruction = ""): Promise<EmailCopy> => {
    const response = await client.messages.create({
      model: MODEL_RECOVERY_EMAIL,
      max_tokens: 1000,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      messages: [{ role: "user", content: prompt + instruction }],
    });
    return readGeneratedCopy(response, "win-back email");
  };

  // Job J01, layers 3 and 4. Legacy's win-back hard-strips subject and body
  // (process-winback blob `18f20de9` lines 393 to 404) but SKIPS the retry the
  // recovery path makes. The job asks for all four layers on both paths, so
  // the win-back seam retries once too: a difference in spend, not in what a
  // customer reads, and never more than one extra call.
  return applyTimingWordGuard(await call(), call);
}
