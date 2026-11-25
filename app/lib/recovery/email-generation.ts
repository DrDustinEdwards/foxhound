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

// AI dunning copy in the MERCHANT's brand voice, with no AI tells and no em dashes. The Claude call (`generateDunningEmail`) is inert until ANTHROPIC_API_KEY is set; the rest is pure.
// Cache order (SCHEMA.md recovery_steps): custom_body wins over cached AI, cached AI before generating. The subject always comes from cache-or-generation.

// Em/en dash is the clearest AI tell: replace with a comma.
const DASH_PATTERN = /\s*[\u2014\u2013]\s*/g;

/** Strip em/en dashes, replacing each with a comma. Pure, deterministic. */
export function stripEmDashes(text: string): string {
  return text.replace(DASH_PATTERN, ", ");
}

// Machine-sounding phrasing is not cut here (it breaks sentences); app/lib/ai/plain-writing.ts names it and the model rewrites.

/** Strip dashes and collapse the whitespace they leave. */
export function sanitizeCopy(text: string): string {
  const out = stripEmDashes(text);
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// Schedule leaks ("day 3", "72 hours since") are detected, not stripped, which would mangle sentences.
const TIMING_TELL_PATTERNS: readonly RegExp[] = [
  /\bday\s?\d+\b/i,
  /\b\d+\s+(?:hours?|days?)\s+(?:ago|since|later)\b/i,
  /\b(?:since|after)\s+\d+\s+(?:hours?|days?)\b/i,
];

// No email may say WHEN it is read ("today", "tonight"). Detector and strip read only text outside tags, so an href token is never altered.

/** Not global, so `.test` carries no lastIndex between calls. */
const TIMING_WORD_PATTERN =
  /\b(today|tonight|yesterday|this morning|this afternoon|this evening|right now|immediately|by end of day)\b/i;

export const TIMING_RETRY_INSTRUCTION =
  "\n\nADDITIONAL INSTRUCTION:\nThe previous subject contained a timing word like 'today' or 'tonight'. Rewrite it without any timing-specific words. The customer may read this hours or days after it was sent.";

/** Splits HTML: odd indexes are tags, even indexes the text between. */
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

/** Tidies spaces and tabs only, in text parts the strip changed. */
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

/** Layers 3 and 4 for one generated email, shared by both seams; what still leaks is hard-stripped. */
async function applyTimingWordGuard(
  first: EmailCopy,
  retry: (instruction: string) => Promise<EmailCopy>,
  allow: readonly string[] = [],
): Promise<EmailCopy> {
  let copy = first;
  if (hasTimingWord(copy.subject)) {
    try {
      const retried = await retry(TIMING_RETRY_INSTRUCTION);
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
function readGeneratedCopy(
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

/** Last steps after both retries: sanitizer, then the stray-content check (voice-samples.ts), which throws so the caller sends the template. */
function finishCopy(copy: EmailCopy, samples: readonly string[], url: string): EmailCopy {
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

/** One retry on stock phrasing; a retry that loses its subject or body is dropped. */
function applyStockPhrasingGuard(
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

/** Send from cache/custom content, or generate when the body or subject is missing (custom_body is carried forward). */
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

/** Combine generated copy with a merchant override: custom body wins; the subject comes from generation. */
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

/** Last rung of resolveBrandVoice, when neither merchant nor category sets a voice. */
const DEFAULT_VOICE = "Friendly and direct. Write like a real person, not a company.";

/** Resolve the brand-voice descriptor for the prompt; lets "Same as main voice" be NULL. */
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

/** Category-specific prompt framing. `revoked` differs: the customer revoked authorization, so offer a cancel-or-update choice rather than dun. */
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

/**
 * One generation: the prompt (with `system` for dunning, none for win-back) through the model, the
 * stock-phrasing guard, then the timing-word guard, then `finishCopy`. A rewrite is the same prompt
 * with its instruction appended, and one attempt.
 */
export async function generateGuardedCopy(
  env: Env,
  meter: AiCallMeter,
  input: {
    kind: string;
    maxTokens: number;
    system?: string;
    prompt: string;
    samples: readonly string[];
    url: string;
  },
): Promise<EmailCopy> {
  const call = async (instruction = ""): Promise<EmailCopy> => {
    const result = await askStructured<{ subject: string; bodyHtml: string }>(
      env,
      meter,
      {
        model: MODEL_RECOVERY_EMAIL,
        max_tokens: input.maxTokens,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: input.system,
        messages: [{ role: "user", content: input.prompt + instruction }],
      },
      OUTPUT_SCHEMA,
      instruction ? REWRITE : {},
    );
    return readGeneratedCopy(result, input.kind);
  };
  const allow = ownPhrasing(input.samples);
  const copy = await applyTimingWordGuard(
    await applyStockPhrasingGuard(await call(), call, allow),
    call,
    allow,
  );
  return finishCopy(copy, input.samples, input.url);
}

export function generateDunningEmail(
  env: Env,
  input: GenerateEmailInput,
  meter: AiCallMeter,
): Promise<EmailCopy> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const prompts = buildPrompts(input);
  return generateGuardedCopy(env, meter, {
    kind: "recovery email",
    maxTokens: 2000,
    system: prompts.system,
    prompt: prompts.user,
    samples: input.merchant.voiceSamples ?? [],
    url: input.updateUrl,
  });
}
