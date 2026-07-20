import Anthropic from "@anthropic-ai/sdk";

import { MODEL_RECOVERY_EMAIL } from "~/lib/constants";

// AI dunning-copy generation. Copy is written in the MERCHANT's brand voice, not
// Foxhound's, and must carry no AI tells and no em dashes (hard brand rules from
// the global style guide). The Claude call itself is an isolated seam
// (`generateDunningEmail`) that stays inert until ANTHROPIC_API_KEY is set; every
// other export here is pure and unit-tested so the sanitizers and the cache-order
// resolution are proven without a live model call.
//
// Cache order (SCHEMA.md recovery_steps.{custom_body, ai_subject, ai_body_html}):
//   custom_body (merchant override for the body) wins over cached AI, cached AI
//   is reused before spending a generation, and generation is the last resort.
// The subject always comes from cache-or-generation; a merchant custom body never
// gets regenerated once set.

// ---- Hard brand rules: sanitizers ----

// Em dash / en dash: the most recognizable AI tell. Replace a dash (with any
// surrounding spaces) by a comma so the pause reads naturally.
const DASH_PATTERN = /\s*[—–]\s*/g;

/** Strip em/en dashes, replacing each with a comma. Pure, deterministic. */
export function stripEmDashes(text: string): string {
  return text.replace(DASH_PATTERN, ", ");
}

// Filler phrases that read as machine-written. Removed as fixed strings (safe:
// no grammar left behind because each carries its own trailing punctuation/space).
const AI_TELL_PHRASES: readonly RegExp[] = [
  /\bI hope this (?:email|message) finds you well[.,]?\s*/gi,
  /\bwe understand that[.,]?\s*/gi,
  /\brest assured[.,]?\s*/gi,
  /\bat your earliest convenience\b/gi,
  /\bplease don't hesitate to\b/gi,
];

/**
 * Apply the safe deterministic transforms to generated copy: strip dashes, drop
 * fixed AI-tell filler, and collapse the whitespace those removals leave behind.
 */
export function sanitizeCopy(text: string): string {
  let out = stripEmDashes(text);
  for (const phrase of AI_TELL_PHRASES) {
    out = out.replace(phrase, "");
  }
  // Collapse runs of spaces/tabs (not newlines) and trim line-trailing space.
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

// Internal-schedule leaks: the model must never reveal the dunning cadence to the
// customer ("day 3", "72 hours since", "3 days ago"). These are DETECTED for the
// quality gate rather than stripped, because removing them would mangle sentences.
const TIMING_TELL_PATTERNS: readonly RegExp[] = [
  /\bday\s?\d+\b/i,
  /\b\d+\s+(?:hours?|days?)\s+(?:ago|since|later)\b/i,
  /\b(?:since|after)\s+\d+\s+(?:hours?|days?)\b/i,
];

export interface EmailCopy {
  subject: string;
  bodyHtml: string;
}

export type BrandVoiceViolation = "em_dash" | "ai_tell" | "timing_leak" | "empty";

/**
 * Flag brand-voice violations in a piece of copy. Used as the quality gate before
 * a generated email is allowed to send: any violation means regenerate or reject.
 * Post-`sanitizeCopy`, `em_dash`/`ai_tell` should be clear; `timing_leak` is the
 * detector that a sanitizer cannot safely fix.
 */
export function findBrandVoiceViolations(copy: EmailCopy): BrandVoiceViolation[] {
  const violations = new Set<BrandVoiceViolation>();
  const both = `${copy.subject}\n${copy.bodyHtml}`;
  if (!copy.subject.trim() || !copy.bodyHtml.trim()) violations.add("empty");
  if (/[—–]/.test(both)) violations.add("em_dash");
  for (const phrase of AI_TELL_PHRASES) {
    // fresh lastIndex: these are /g regexes reused across calls
    phrase.lastIndex = 0;
    if (phrase.test(both)) violations.add("ai_tell");
  }
  for (const pat of TIMING_TELL_PATTERNS) {
    if (pat.test(both)) violations.add("timing_leak");
  }
  return [...violations];
}

/** True when the copy is clean enough to send. */
export function passesQualityGate(copy: EmailCopy): boolean {
  return findBrandVoiceViolations(copy).length === 0;
}

// ---- Cache-order resolution ----

/** The cached content columns on a recovery_steps row, as read before a send. */
export interface CachedStepContent {
  /** Merchant-authored body override. Wins over any AI body; never regenerated. */
  customBody: string | null;
  /** Previously generated subject for this step. */
  cachedSubject: string | null;
  /** Previously generated (or merchant) HTML body cached for this step. */
  cachedBodyHtml: string | null;
}

export type ContentPlan =
  | { source: "cache"; copy: EmailCopy; usedCustomBody: boolean }
  | { source: "generate"; customBody: string | null };

/**
 * Decide whether a step can send from cache/custom content or must generate.
 * Body precedence is custom_body > cached ai_body_html; subject comes from the
 * cached subject. If either the resolved body or the subject is missing, we must
 * generate (carrying any custom_body forward so it is never overwritten).
 */
export function resolveContentPlan(cached: CachedStepContent): ContentPlan {
  const body = cached.customBody ?? cached.cachedBodyHtml;
  const subject = cached.cachedSubject;
  if (subject && subject.trim() && body && body.trim()) {
    return {
      source: "cache",
      copy: { subject, bodyHtml: body },
      usedCustomBody: cached.customBody != null,
    };
  }
  return { source: "generate", customBody: cached.customBody };
}

/**
 * Combine freshly generated copy with any merchant override: the custom body
 * always wins for the body; the subject is taken from generation. This is applied
 * after `generateDunningEmail` so a generation for a step that has a custom_body
 * only contributes the subject.
 */
export function applyCustomBody(generated: EmailCopy, customBody: string | null): EmailCopy {
  return {
    subject: generated.subject,
    bodyHtml: customBody ?? generated.bodyHtml,
  };
}

// ---- Brand voice ----

export interface MerchantBrandVoice {
  /** Merchant display name used in the copy (e.g. "Acme"). */
  merchantName: string;
  /** Optional merchant-configured tone/voice description. */
  voiceDescription?: string | null;
}

const DEFAULT_VOICE =
  "warm, plain, and direct; a real person from the business writing a short note";

/** Resolve the brand-voice descriptor for the prompt, with a sensible default. */
export function resolveBrandVoice(merchant: MerchantBrandVoice): string {
  const voice = merchant.voiceDescription?.trim();
  return voice && voice.length > 0 ? voice : DEFAULT_VOICE;
}

// ---- Generation seam (isolated; inert without ANTHROPIC_API_KEY) ----

export interface GenerateEmailInput {
  merchant: MerchantBrandVoice;
  /** Which scheduled step this is (drives urgency, never surfaced as timing). */
  stepType: string;
  /** Decline category, for tone (e.g. expired -> "update your card"). */
  declineCategory: string;
  amountFormatted: string;
  /** Hosted card-update link the body must include as the primary call to action. */
  updateUrl: string;
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string" },
    bodyHtml: { type: "string" },
  },
  required: ["subject", "bodyHtml"],
} as const;

function buildSystemPrompt(brandVoice: string): string {
  return [
    "You write short payment-recovery emails on behalf of a business, in that",
    `business's own voice: ${brandVoice}.`,
    "Rules you must follow exactly:",
    "- Never use em dashes or en dashes. Use commas or short sentences.",
    "- Never mention how many days or hours it has been, or reference an internal",
    "  schedule ('day 3', '72 hours ago'). Speak only to the present.",
    "- No corporate filler, no AI-sounding phrases, no 'I hope this finds you well'.",
    "- Sound like a real person from the business, not a template.",
    "- Keep it short. One clear call to action: the update link provided.",
    "- Output valid HTML for the body.",
  ].join("\n");
}

/**
 * Extra, category-specific framing folded into the generation prompt so the copy
 * matches what actually happened, not a generic "your payment failed, please pay".
 * Most categories share the default recovery framing (fix the payment via the
 * link); `revoked` is deliberately different: the customer explicitly revoked
 * authorization, so the note must offer a clean cancel-or-update choice rather
 * than dun them. Returns null when the default framing is correct.
 */
export function categoryGuidance(declineCategory: string): string | null {
  if (declineCategory === "revoked") {
    return [
      "IMPORTANT FRAMING: the customer has revoked authorization for this recurring",
      "payment with their bank, so this is not an ordinary failed payment. Do not ask",
      "them to pay, do not imply they owe money, and do not use urgency. Acknowledge",
      "that the subscription will end, and offer a clean choice: they can let it stop,",
      "or, only if they meant to keep it, add a new payment method using the link.",
      "Keep the tone respectful, brief, and low pressure.",
    ].join(" ");
  }
  return null;
}

function buildUserPrompt(input: GenerateEmailInput): string {
  const guidance = categoryGuidance(input.declineCategory);
  return [
    `Business: ${input.merchant.merchantName}`,
    `A customer's payment of ${input.amountFormatted} did not go through`,
    `(reason category: ${input.declineCategory}).`,
    guidance ?? `Write a brief note asking them to fix it using this link: ${input.updateUrl}`,
    guidance ? `The link to add a new payment method is: ${input.updateUrl}` : "",
    "Return a subject line and an HTML body.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Generate dunning copy via Sonnet. Isolated seam: constructs the Anthropic client
 * per call from env (mirrors the Stripe client factory), asks for structured
 * output, then sanitizes the result. The caller is responsible for the quality
 * gate and for `applyCustomBody`. Throws if ANTHROPIC_API_KEY is unset.
 *
 * NOTE (Phase 4b): not live-verified this pass; ANTHROPIC_API_KEY is Dustin-gated
 * and the end-to-end send path lands in Phase 4c. The pure helpers above are the
 * tested surface.
 */
export async function generateDunningEmail(
  env: Env,
  input: GenerateEmailInput,
): Promise<EmailCopy> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: MODEL_RECOVERY_EMAIL,
    max_tokens: 2000,
    thinking: { type: "disabled" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: buildSystemPrompt(resolveBrandVoice(input.merchant)),
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("recovery email generation returned no text block");
  }
  const parsed = JSON.parse(textBlock.text) as { subject: string; bodyHtml: string };
  return {
    subject: sanitizeCopy(parsed.subject),
    bodyHtml: sanitizeCopy(parsed.bodyHtml),
  };
}
