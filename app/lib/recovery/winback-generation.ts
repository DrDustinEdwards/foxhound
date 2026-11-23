import { plural } from "@drdustinedwards/site-helpers/text";
import { UNTRUSTED_DATA_RULE, untrusted } from "@dustinedwards/site-runtime/anthropic";

import { askStructured, REWRITE, type AiCallMeter } from "~/lib/ai/client";
import { PLAIN_WRITING_PROMPT, ownPhrasing } from "~/lib/ai/plain-writing";
import { MODEL_RECOVERY_EMAIL } from "~/lib/constants";

import {
  applyStockPhrasingGuard,
  applyTimingWordGuard,
  finishCopy,
  readGeneratedCopy,
  type EmailCopy,
} from "./email-generation";
import { voiceSampleLines } from "./voice-samples";

// THE WIN-BACK AI HALF. IT IS A SEPARATE BUILDER, NOT THE DUNNING SCAFFOLD. THE VOICE IS THE
// GENERAL ONE, AND ONLY THAT.

/**
 * Step 3 is the "last chance, no pressure" line the brief asks about. THE DELAY IS THE STEP'S OWN,
 * not a typed literal (a truthfulness fix).
 */
const STEP_DESCRIPTIONS: Record<number, { which: string; tone: string }> = {
  1: { which: "first", tone: "warm, empathetic, not pushy" },
  2: { which: "second", tone: "share value, mention improvements" },
  3: { which: "final", tone: "last chance, no pressure" },
};

/** Pure. */
function describeWinbackDelay(offsetHours: number): string {
  const hours = Math.max(0, Math.round(offsetHours));
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return plural(days, "day");
  }
  return plural(hours, "hour");
}

function describeStep(stepNumber: number, offsetHours: number): string {
  const step = STEP_DESCRIPTIONS[stepNumber];
  if (!step) return "win-back email";
  return `${step.which} win-back email sent ${describeWinbackDelay(offsetHours)} after cancellation, ${step.tone}`;
}

const WINBACK_VOICE_FALLBACK = "friendly and conversational";

export interface WinbackPromptInput {
  stepNumber: number;
  /** Hours from the cancellation to this step's send, as scheduled. Required,
   *  so every caller states the real delay rather than a default. */
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
 * The line is dropped rather than recoloured, because a style instruction naming colors Foxhound
 * does not have would ask the model for the wrong thing.
 */
export function buildWinbackPrompt(input: WinbackPromptInput): string {
  const description = describeStep(input.stepNumber, input.offsetHours);
  return [
    "You are writing a win-back email for a SaaS business trying to re-engage a canceled customer.",
    "",
    `This is a ${description}.`,
    "",
    UNTRUSTED_DATA_RULE,
    "",
    "Customer details:",
    `- Name: ${untrusted("customer_name", input.customerName)}`,
    `- Canceled plan: ${untrusted("plan_name", input.planName)}`,
    `- Cancellation reason: ${input.cancelReason ? untrusted("cancel_reason", input.cancelReason) : "not provided"}`,
    "",
    "Email requirements:",
    `- Brand voice: ${input.brandVoice ? untrusted("brand_voice", input.brandVoice) : WINBACK_VOICE_FALLBACK}`,
    ...voiceSampleLines(input.voiceSamples ?? []),
    "- Keep it under 120 words",
    `- Include a reactivation button linking to: ${input.resubscribeUrl}`,
    `- Sender name: ${untrusted("sender_name", input.senderName)}`,
    "- Do NOT be desperate or salesy, be genuine",
    "- Never use timing words like 'today', 'tonight', 'yesterday', 'this morning', 'this afternoon', 'this evening', 'right now', 'immediately' or 'by end of day' in the subject or the body, you do not know when the customer will read this",
    "",
    PLAIN_WRITING_PROMPT,
    "",
    "Respond ONLY in this exact JSON format with no preamble or markdown:",
    '{"subject":"<email subject line>","bodyHtml":"<full HTML email body>"}',
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
 * Generate one win-back email. The model is `MODEL_RECOVERY_EMAIL`, the same constant the dunning
 * generator uses.
 */
export async function generateWinbackEmail(
  env: Env,
  input: WinbackPromptInput,
  meter: AiCallMeter,
): Promise<EmailCopy> {
  const prompt = buildWinbackPrompt(input);

  // One call shape for the first call and the rewrites: a rewrite is the same
  // prompt with its instruction appended, and one attempt.
  const call = async (instruction = ""): Promise<EmailCopy> => {
    const result = await askStructured<{ subject: string; bodyHtml: string }>(
      env,
      meter,
      {
        model: MODEL_RECOVERY_EMAIL,
        max_tokens: 1000,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        messages: [{ role: "user", content: prompt + instruction }],
      },
      OUTPUT_SCHEMA,
      instruction ? REWRITE : {},
    );
    return readGeneratedCopy(result, "win-back email");
  };

  // Layers 3 and 4. The job asks for all four layers on both paths, so the win-back seam
  // retries once too: a difference in spend, not in what a customer reads, and never more than one
  // extra call.
  const samples = input.voiceSamples ?? [];
  const allow = ownPhrasing(samples);
  const copy = await applyTimingWordGuard(
    await applyStockPhrasingGuard(await call(), call, allow),
    call,
    allow,
  );
  return finishCopy(copy, samples, input.resubscribeUrl);
}
