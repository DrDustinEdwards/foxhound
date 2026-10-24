import { createAnthropicClient } from "~/lib/ai/client";
import { UNTRUSTED_DATA_RULE, untrusted } from "~/lib/ai/untrusted";
import { MODEL_RECOVERY_EMAIL } from "~/lib/constants";

import {
  PLAIN_WRITING_LINES,
  applyStockPhrasingGuard,
  applyTimingWordGuard,
  readGeneratedCopy,
  type EmailCopy,
} from "./email-generation";
import { voiceSampleLines } from "./voice-samples";

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

/** Legacy's per-step descriptions, in its words and with the tone each carries.
 *  Step 3 is the "last chance, no pressure" line the brief asks about.
 *
 *  THE DELAY IS THE STEP'S OWN, not a typed literal (J91, a truthfulness fix).
 *  Legacy writes "1 hour", "4 days" and "14 days" into the prompt, which are its
 *  WIN_BACK_SCHEDULE offsets; but on an account with Intelligence step 1 goes
 *  at WINBACK_UNFLAGGED_STEP1_HOURS (4) unless the customer is flagged, and
 *  nothing flags one yet, so "1 hour" told the model something untrue there.
 *  The cron passes the delay it read off the step (scheduled_at less the
 *  sequence's created_at, which is the cancellation); legacy's three offsets
 *  still read exactly as legacy words them. */
const STEP_DESCRIPTIONS: Record<number, { which: string; tone: string }> = {
  1: { which: "first", tone: "warm, empathetic, not pushy" },
  2: { which: "second", tone: "share value, mention improvements" },
  3: { which: "final", tone: "last chance, no pressure" },
};

/** A delay in legacy's words: whole days when it is a whole number of days,
 *  else hours ("1 hour", "4 hours", "4 days", "14 days"). Pure. */
function describeWinbackDelay(offsetHours: number): string {
  const hours = Math.max(0, Math.round(offsetHours));
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function describeStep(stepNumber: number, offsetHours: number): string {
  const step = STEP_DESCRIPTIONS[stepNumber];
  if (!step) return "win-back email";
  return `${step.which} win-back email sent ${describeWinbackDelay(offsetHours)} after cancellation, ${step.tone}`;
}

/** Legacy's `${merchant.brand_voice || 'friendly and conversational'}`.
 *
 *  NOT `BRAND_VOICE_DEFAULT`. 338 aligned the DUNNING default to legacy's
 *  constant ("Friendly and direct. Write like a real person, not a company."),
 *  and legacy's win-back prompt carries a DIFFERENT literal. Ported as found
 *  rather than unified, because the two are legacy's own two strings. */
export const WINBACK_VOICE_FALLBACK = "friendly and conversational";

export interface WinbackPromptInput {
  stepNumber: number;
  /** Hours from the cancellation to this step's send, as scheduled. Required,
   *  so every caller states the real delay rather than a default (J91). */
  offsetHours: number;
  customerName: string;
  planName: string;
  cancelReason: string | null;
  /** `stripe_connections.brand_voice`, the general voice. */
  brandVoice: string | null;
  /** The merchant's own past emails (voice-samples.ts); empty when none. */
  voiceSamples?: readonly string[];
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
 * THE ADDITION OF 2026-10-24, an approved difference from Recova: the
 * merchant's own past emails after the brand-voice line, and the family's
 * plain-writing lines (site-runtime ./prose) after the requirements.
 *
 * THE ADDITION, job J01: the timing-word requirement line. Legacy's win-back
 * gets that rule from its Haiku quality-check prompt (lib/email-generation.ts
 * blob `e28d780e` line 344), a second pass Foxhound does not have, so this
 * prompt is the only place the rule can live. It names the same nine phrases
 * as the detector. The step's delay is the real one (STEP_DESCRIPTIONS, J91).
 * Every other line is legacy's.
 *
 * Pure, so a plant reads the real prompt bytes rather than a rebuilt copy
 * (337 binding 4).
 */
export function buildWinbackPrompt(input: WinbackPromptInput): string {
  const description = describeStep(input.stepNumber, input.offsetHours);
  return [
    "You are writing a win-back email for a SaaS business trying to re-engage a cancelled customer.",
    "",
    `This is a ${description}.`,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "Customer details:",
    `- Name: ${untrusted(input.customerName)}`,
    `- Cancelled plan: ${untrusted(input.planName)}`,
    `- Cancellation reason: ${input.cancelReason ? untrusted(input.cancelReason) : "not provided"}`,
    "",
    "Email requirements:",
    `- Brand voice: ${input.brandVoice ? untrusted(input.brandVoice) : WINBACK_VOICE_FALLBACK}`,
    ...voiceSampleLines(input.voiceSamples ?? []),
    "- Keep it under 120 words",
    `- Include a reactivation button linking to: ${input.resubscribeUrl}`,
    `- Sender name: ${untrusted(input.senderName)}`,
    "- Do NOT be desperate or salesy, be genuine",
    "- Never use timing words like 'today', 'tonight', 'yesterday', 'this morning', 'this afternoon', 'this evening', 'right now', 'immediately' or 'by end of day' in the subject or the body, you do not know when the customer will read this",
    "",
    "Plain writing:",
    ...PLAIN_WRITING_LINES,
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
  // The stock-phrasing retry comes first, on the same terms (one call at most).
  return applyTimingWordGuard(await applyStockPhrasingGuard(await call(), call), call);
}
