import { UNTRUSTED_DATA_RULE, untrusted } from "@dustinedwards/site-runtime/anthropic";

import { askStructured, REWRITE, type AiCallMeter } from "~/lib/ai/client";
import {
  PLAIN_WRITING_PROMPT,
  findStockPhrasing,
  ownPhrasing,
  retryStockPhrasing,
} from "~/lib/ai/plain-writing";
import { MODEL_RECOVERY_EMAIL } from "~/lib/constants";

import { strayContent, voiceSampleLines } from "./voice-samples";

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

// Em dash / en dash: the most recognizable AI tell. Replace a dash (with any surrounding spaces) by
// a comma so the pause reads naturally.
const DASH_PATTERN = /\s*[\u2014\u2013]\s*/g;

/** Strip em/en dashes, replacing each with a comma. Pure, deterministic. */
export function stripEmDashes(text: string): string {
  return text.replace(DASH_PATTERN, ", ");
}

// Phrasing that reads as machine-written is not cut here: cutting a phrase
// leaves a broken sentence. The plain-writing check (app/lib/ai/plain-writing.ts)
// names it and the model writes the draft again.

/**
 * Apply the safe deterministic transforms to generated copy: strip dashes and
 * collapse the whitespace they leave behind.
 */
export function sanitizeCopy(text: string): string {
  const out = stripEmDashes(text);
  // Collapse runs of spaces/tabs (not newlines) and trim line-trailing space.
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// Internal-schedule leaks: the model must never reveal the dunning cadence to the
// customer ("day 3", "72 hours since", "3 days ago"). These are DETECTED for the
// quality gate rather than stripped, because removing them would mangle sentences.
const TIMING_TELL_PATTERNS: readonly RegExp[] = [
  /\bday\s?\d+\b/i,
  /\b\d+\s+(?:hours?|days?)\s+(?:ago|since|later)\b/i,
  /\b(?:since|after)\s+\d+\s+(?:hours?|days?)\b/i,
];

// The customer may read the email hours or days after it was sent, so no recovery or win-back email
// may say WHEN it is being read ("today", "tonight"). The detector and the strip read only TEXT
// OUTSIDE TAGS, so an href token or an attribute that happens to contain "today" is never read and
// never altered, and the update-link check downstream is never tripped by the strip.

/** Not global, so `.test` carries no lastIndex between calls. */
const TIMING_WORD_PATTERN =
  /\b(today|tonight|yesterday|this morning|this afternoon|this evening|right now|immediately|by end of day)\b/i;

export const TIMING_RETRY_INSTRUCTION =
  "\n\nADDITIONAL INSTRUCTION:\nThe previous subject contained a timing word like 'today' or 'tonight'. Rewrite it without any timing-specific words. The customer may read this hours or days after it was sent.";

/** Splits HTML so that odd indexes are tags (`<...>`) and even indexes are the
 *  text between them. A subject has no tags and comes back as one text part. */
const TAG_SPLIT = /(<[^>]*>)/;

function textParts(text: string): string[] {
  return text.split(TAG_SPLIT).filter((_, i) => i % 2 === 0);
}

/** Safe for a plain subject and for an HTML body. */
export function hasTimingWord(text: string): boolean {
  return textParts(text).some((part) => TIMING_WORD_PATTERN.test(part));
}

const TIMING_WORD_REPLACEMENTS: readonly [RegExp, string][] = [
  [/\bcloses tonight\b/gi, "will close soon"],
  [/\bends today\b/gi, "is ending"],
  [/\bby end of day\b/gi, "soon"],
  [/\btonight\b/gi, ""],
  [/\btoday\b/gi, "now"],
  [/\byesterday\b/gi, ""],
  [/\bthis (morning|afternoon|evening)\b/gi, ""],
  [/\bright now\b/gi, "now"],
  [/\bimmediately\b/gi, ""],
];

/**
 * Here the tidy is spaces and tabs only, and only in a text part the strip actually changed; tags
 * are never touched and untouched text stays byte for byte.
 */
export function hardStripTimingWords(text: string): string {
  const parts = text.split(TAG_SPLIT);
  for (let i = 0; i < parts.length; i += 2) {
    const original = parts[i];
    let part = original;
    for (const [pattern, replacement] of TIMING_WORD_REPLACEMENTS) {
      part = part.replace(pattern, replacement);
    }
    if (part !== original) {
      parts[i] = part.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,!?])/g, "$1");
    }
  }
  return parts.join("").trim();
}

/**
 * Layers 3 and 4 for one generated email, shared by both model seams. Then whatever still leaks is
 * hard-stripped, subject and body separately.
 */
export async function applyTimingWordGuard(
  first: EmailCopy,
  retry: (instruction: string) => Promise<EmailCopy>,
  allow: readonly string[] = [],
): Promise<EmailCopy> {
  let copy = first;
  if (hasTimingWord(copy.subject)) {
    try {
      const retried = await retry(TIMING_RETRY_INSTRUCTION);
      // Never trade a timing word for stock phrasing the first guard took out:
      // the hard strip below handles the timing word either way.
      const stock = (c: EmailCopy) => findStockPhrasing(readableText(c), allow).length;
      if (retried.subject.trim() && retried.bodyHtml.trim() && stock(retried) <= stock(copy))
        copy = retried;
    } catch (err) {
      // The message only: an SDK error object can carry request details.
      console.error(
        "timing-word retry failed; keeping the first copy:",
        err instanceof Error ? err.message : "unknown error",
      );
    }
  }
  return {
    subject: hasTimingWord(copy.subject) ? hardStripTimingWords(copy.subject) : copy.subject,
    bodyHtml: hasTimingWord(copy.bodyHtml) ? hardStripTimingWords(copy.bodyHtml) : copy.bodyHtml,
  };
}

/** Read one structured-output reply into copy as the model wrote it. */
export function readGeneratedCopy(
  result: Awaited<ReturnType<typeof askStructured<{ subject: string; bodyHtml: string }>>>,
  label: string,
): EmailCopy {
  // A failed call (refused, cut off, unparsable, unreachable) throws, and the
  // caller sends the template. The kind is safe to log; the provider's text never reaches here.
  if (!result.ok) throw new Error(`${label} generation failed: ${result.kind}`);
  return {
    subject: String(result.value.subject ?? "").trim(),
    bodyHtml: String(result.value.bodyHtml ?? "").trim(),
  };
}

/**
 * The seams' last steps, after both retries: the deterministic sanitizer, then the stray-content
 * check (voice-samples.ts), which throws so the caller sends the template.
 */
export function finishCopy(copy: EmailCopy, samples: readonly string[], url: string): EmailCopy {
  const done = { subject: sanitizeCopy(copy.subject), bodyHtml: sanitizeCopy(copy.bodyHtml) };
  const stray = strayContent(done.bodyHtml, readableText(done), samples, url);
  if (stray.length > 0)
    throw new Error(`generated email carries what it was not given: ${stray.length} item(s)`);
  return done;
}

export interface EmailCopy {
  subject: string;
  bodyHtml: string;
}

export type BrandVoiceViolation = "em_dash" | "timing_leak" | "empty";

/** The copy as a reader sees it: tags dropped, paragraphs and breaks as lines. */
function readableText(copy: EmailCopy): string {
  const body = copy.bodyHtml
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ");
  return `${copy.subject}\n\n${body}`;
}

/**
 * One retry when the first draft carries stock phrasing; a retry that loses its subject or body is
 * never kept.
 */
export function applyStockPhrasingGuard(
  first: EmailCopy,
  retry: (instruction: string) => Promise<EmailCopy>,
  allow: readonly string[] = [],
): Promise<EmailCopy> {
  return retryStockPhrasing(
    first,
    (copy) => (copy.subject.trim() && copy.bodyHtml.trim() ? readableText(copy) : ""),
    retry,
    allow,
  );
}

/** Flag brand-voice violations in a piece of copy. */
export function findBrandVoiceViolations(copy: EmailCopy): BrandVoiceViolation[] {
  const violations = new Set<BrandVoiceViolation>();
  const both = `${copy.subject}\n${copy.bodyHtml}`;
  if (!copy.subject.trim() || !copy.bodyHtml.trim()) violations.add("empty");
  if (/[\u2014\u2013]/.test(both)) violations.add("em_dash");
  for (const pat of TIMING_TELL_PATTERNS) {
    if (pat.test(both)) violations.add("timing_leak");
  }
  // Read outside tags only, so an href token is never a leak.
  if (
    hasTimingWord(copy.subject) ||
    hasTimingWord(copy.bodyHtml) ||
    TIMING_WORD_PATTERN.test(copy.bodyHtml.replace(/<[^>]*>/g, ""))
  ) {
    violations.add("timing_leak");
  }
  return [...violations];
}

/** True when the copy is clean enough to send. */
export function passesQualityGate(copy: EmailCopy): boolean {
  return findBrandVoiceViolations(copy).length === 0;
}

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
 * Decide whether a step can send from cache/custom content or must generate. If either the resolved
 * body or the subject is missing, we must generate (carrying any custom_body forward so it is never
 * overwritten).
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
 * Combine freshly generated copy with any merchant override: the custom body always wins for the
 * body; the subject is taken from generation. This is applied after `generateDunningEmail` so a
 * generation for a step that has a custom_body only contributes the subject.
 */
export function applyCustomBody(generated: EmailCopy, customBody: string | null): EmailCopy {
  return {
    subject: generated.subject,
    bodyHtml: customBody ?? generated.bodyHtml,
  };
}

export interface MerchantBrandVoice {
  /** Merchant display name used in the copy (e.g. "Acme"). */
  merchantName: string;
  /** Optional merchant-configured tone/voice description. */
  voiceDescription?: string | null;
  /** The three merchant-context fields, from `accounts`. */
  industry?: string | null;
  customerType?: string | null;
  mrrCents?: number | null;
  /** The four per-category voices, from `stripe_connections`. */
  voiceSoft?: string | null;
  voiceExpired?: string | null;
  voiceNetwork?: string | null;
  voiceFraud?: string | null;
  /** The merchant's own past emails (voice-samples.ts), which every category's
   *  draft is written from beside the resolved voice. */
  voiceSamples?: readonly string[] | null;
}

/**
 * Reads the three merchant-context columns. `mrrCents` of 0 is falsy on both sides, so a merchant
 * reporting zero MRR contributes no part.
 */
function merchantContextLine(merchant: MerchantBrandVoice): string | null {
  const parts: string[] = [];
  if (merchant.industry) parts.push(`${merchant.industry} business`);
  if (merchant.customerType) parts.push(`serving ${merchant.customerType} customers`);
  if (merchant.mrrCents) parts.push(`with ~$${Math.round(merchant.mrrCents / 100)}/month MRR`);
  return parts.length > 0 ? `Merchant context: ${parts.join(" ")}` : null;
}

/**
 * The last rung of resolveBrandVoice, used when neither the merchant nor the category sets a voice.
 */
const DEFAULT_VOICE = "Friendly and direct. Write like a real person, not a company.";

/**
 * Resolve the brand-voice descriptor for the prompt. That is what makes "Same as main voice"
 * storable as NULL rather than needing a sentinel.
 */
export function resolveBrandVoice(merchant: MerchantBrandVoice, declineCategory: string): string {
  const general = merchant.voiceDescription?.trim();
  const fallback = general && general.length > 0 ? general : DEFAULT_VOICE;

  const categoryVoice = categoryVoiceFor(merchant, declineCategory)?.trim();
  return categoryVoice && categoryVoice.length > 0 ? categoryVoice : fallback;
}

/** Separated so the six-against-four mapping is one readable place. */
function categoryVoiceFor(
  merchant: MerchantBrandVoice,
  declineCategory: string,
): string | null | undefined {
  switch (declineCategory) {
    case "soft":
      return merchant.voiceSoft;
    case "expired":
      return merchant.voiceExpired;
    case "network":
      return merchant.voiceNetwork;
    case "fraud":
      return merchant.voiceFraud;
    default:
      // `revoked` and `unknown` land here, as does anything unrecognized.
      return undefined;
  }
}

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

function buildSystemPrompt(brandVoice: string, samples: readonly string[]): string {
  return [
    "You write short payment-recovery emails on behalf of a business, in that",
    `business's own voice: ${untrusted("brand_voice", brandVoice)}.`,
    ...voiceSampleLines(samples),
    UNTRUSTED_DATA_RULE,
    "Rules you must follow exactly:",
    "- Never mention how many days or hours it has been, or reference an internal",
    "  schedule ('day 3', '72 hours ago'). Speak only to the present.",
    "- Never use timing words like 'today', 'tonight', 'yesterday', 'this morning',",
    "  'this afternoon', 'this evening', 'right now', 'immediately' or 'by end of day'",
    "  in the subject or the body. You do not know when the customer will read this.",
    "- No corporate filler and no AI-sounding phrases.",
    "- Sound like a real person from the business, not a template.",
    "- Keep it short. One clear call to action: the update link provided.",
    "- Output valid HTML for the body.",
    PLAIN_WRITING_PROMPT,
  ].join("\n");
}

/**
 * Extra, category-specific framing folded into the generation prompt so the copy matches what
 * actually happened, not a generic "your payment failed, please pay". Most categories share the
 * default recovery framing (fix the payment via the link); `revoked` is deliberately different: the
 * customer explicitly revoked authorization, so the note must offer a clean cancel-or-update choice
 * rather than dun them.
 */
function categoryGuidance(declineCategory: string): string | null {
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

export function buildUserPrompt(input: GenerateEmailInput): string {
  const guidance = categoryGuidance(input.declineCategory);
  // Exported so a plant can observe the prompt the model actually receives.
  // The merchant-context line is the output of merchantContextLine: without it the
  // three columns reach nothing.
  const merchantContext = merchantContextLine(input.merchant);
  return [
    `Business: ${untrusted("business_name", input.merchant.merchantName)}`,
    merchantContext ? untrusted("business_context", merchantContext) : "",
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
 * Generate dunning copy via Sonnet. The caller is responsible for the quality gate and for
 * `applyCustomBody`.
 */
/** The exact prompt pair `generateDunningEmail` sends. */
export function buildPrompts(input: GenerateEmailInput): { system: string; user: string } {
  return {
    system: buildSystemPrompt(
      resolveBrandVoice(input.merchant, input.declineCategory),
      input.merchant.voiceSamples ?? [],
    ),
    user: buildUserPrompt(input),
  };
}

export async function generateDunningEmail(
  env: Env,
  input: GenerateEmailInput,
  meter: AiCallMeter,
): Promise<EmailCopy> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const prompts = buildPrompts(input);

  // One call shape for the first call and the rewrites: a rewrite is the same
  // system and user prompt with its instruction appended, and one attempt.
  const call = async (instruction = ""): Promise<EmailCopy> => {
    const result = await askStructured<{ subject: string; bodyHtml: string }>(
      env,
      meter,
      {
        model: MODEL_RECOVERY_EMAIL,
        max_tokens: 2000,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: prompts.system,
        messages: [{ role: "user", content: prompts.user + instruction }],
      },
      OUTPUT_SCHEMA,
      instruction ? REWRITE : {},
    );
    return readGeneratedCopy(result, "recovery email");
  };

  // Stock phrasing first, then layers 3 and 4.
  const samples = input.merchant.voiceSamples ?? [];
  const allow = ownPhrasing(samples);
  const copy = await applyTimingWordGuard(
    await applyStockPhrasingGuard(await call(), call, allow),
    call,
    allow,
  );
  return finishCopy(copy, samples, input.updateUrl);
}
