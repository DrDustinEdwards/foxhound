import { createAnthropicClient } from "~/lib/ai/client";
import { UNTRUSTED_DATA_RULE, untrusted } from "~/lib/ai/untrusted";
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
//
// The two characters are written as \u escapes rather than literals, per
// capsid/conventions.md: where source code needs the literal dash (it names a
// normalization regex as the example), write it as a \uXXXX escape so the
// file stays clean under the rule it enforces, and stays greppable. A regex
// character class reads the escape as that character, so the pattern is
// unchanged. Ruling 331.
const DASH_PATTERN = /\s*[\u2014\u2013]\s*/g;

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

// ---- Timing words (job J01) ----
//
// The customer may read the email hours or days after it was sent, so no
// recovery or win-back email may say WHEN it is being read ("today", "tonight").
// Legacy guards this in four layers and Foxhound ports all four:
//   1. the prompt rule (legacy lib/email-generation.ts blob `e28d780e` line 139;
//      here in buildSystemPrompt and buildWinbackPrompt),
//   2. the detector, legacy's exact nine-phrase regex (same blob, line 83),
//   3. one retry when the SUBJECT leaks (legacy recovery-execution.ts blob
//      `3a8f8768` lines 313 to 344; here in applyTimingWordGuard),
//   4. the hard strip of whatever still leaks (blob `e28d780e` lines 85 to 101;
//      blob `3a8f8768` lines 345 to 351; process-winback blob `18f20de9` lines
//      393 to 404).
// The quality gate below also reads the detector as `timing_leak`, so anything
// that somehow reaches it with a timing word sends the template instead.
//
// ONE ADAPTATION: legacy's bodies were plain text, Foxhound's are HTML. The
// detector and the strip read only TEXT OUTSIDE TAGS, so an href token or an
// attribute that happens to contain "today" is never read and never altered,
// and the update-link check downstream is never tripped by the strip.

/** Legacy's pattern, byte for byte (blob `e28d780e` line 83). Not global, so
 *  `.test` carries no lastIndex between calls. */
export const TIMING_WORD_PATTERN =
  /\b(today|tonight|yesterday|this morning|this afternoon|this evening|right now|immediately|by end of day)\b/i;

/** Legacy's retry instruction, verbatim (blob `3a8f8768` line 321), appended to
 *  the same user message for the one retry. */
export const TIMING_RETRY_INSTRUCTION =
  "\n\nADDITIONAL INSTRUCTION:\nThe previous subject contained a timing word like 'today' or 'tonight'. Rewrite it without any timing-specific words. The customer may read this hours or days after it was sent.";

/** Splits HTML so that odd indexes are tags (`<...>`) and even indexes are the
 *  text between them. A subject has no tags and comes back as one text part. */
const TAG_SPLIT = /(<[^>]*>)/;

function textParts(text: string): string[] {
  return text.split(TAG_SPLIT).filter((_, i) => i % 2 === 0);
}

/** True when the text outside any tag carries one of legacy's nine phrases.
 *  Safe for a plain subject and for an HTML body. */
export function hasTimingWord(text: string): boolean {
  return textParts(text).some((part) => TIMING_WORD_PATTERN.test(part));
}

/** Legacy's replacements, in legacy's order (blob `e28d780e` lines 89 to 97). */
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
 * Remove the nine timing phrases with legacy's replacements, then tidy the
 * spaces a removal leaves (a run of spaces, a space before punctuation).
 *
 * Legacy's tidy is `\s+` to one space across the whole string, which would
 * flatten an HTML body's newlines. Here the tidy is spaces and tabs only, and
 * only in a text part the strip actually changed; tags are never touched and
 * untouched text stays byte for byte. The whole result is trimmed, as legacy's.
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
 * Layers 3 and 4 for one generated email, shared by both model seams.
 *
 * `retry` is the seam's own model call with TIMING_RETRY_INSTRUCTION appended
 * to the same user message. It runs AT MOST ONCE, and only when the SUBJECT
 * leaks, which is legacy's trigger: a second call to fix a body phrase is left
 * to the strip (blob `3a8f8768` lines 313 to 318). Retry copy replaces the
 * first only when it has both a subject and a body; a retry that throws or
 * returns nothing usable keeps the first copy, as legacy's catch does. Then
 * whatever still leaks is hard-stripped, subject and body separately.
 *
 * A first-call failure is not handled here: it throws out of the seam, and the
 * caller sends the template (RULES.md 3.15).
 */
export async function applyTimingWordGuard(
  first: EmailCopy,
  retry: (instruction: string) => Promise<EmailCopy>,
): Promise<EmailCopy> {
  let copy = first;
  if (hasTimingWord(copy.subject)) {
    try {
      const retried = await retry(TIMING_RETRY_INSTRUCTION);
      if (retried.subject.trim() && retried.bodyHtml.trim()) copy = retried;
    } catch (err) {
      // The message only: an SDK error object can carry request details.
      console.error("timing-word retry failed; keeping the first copy:", err instanceof Error ? err.message : "unknown error");
    }
  }
  return {
    subject: hasTimingWord(copy.subject) ? hardStripTimingWords(copy.subject) : copy.subject,
    bodyHtml: hasTimingWord(copy.bodyHtml) ? hardStripTimingWords(copy.bodyHtml) : copy.bodyHtml,
  };
}

/**
 * Read one structured-output reply into sanitized copy. Shared by the dunning
 * and win-back seams, which parse the same `{subject, bodyHtml}` schema.
 */
export function readGeneratedCopy(
  response: { content: { type: string; text?: string }[] },
  label: string,
): EmailCopy {
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    throw new Error(`${label} generation returned no text block`);
  }
  const parsed = JSON.parse(textBlock.text) as { subject: string; bodyHtml: string };
  return {
    subject: sanitizeCopy(parsed.subject),
    bodyHtml: sanitizeCopy(parsed.bodyHtml),
  };
}

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
  if (/[\u2014\u2013]/.test(both)) violations.add("em_dash");
  for (const phrase of AI_TELL_PHRASES) {
    // fresh lastIndex: these are /g regexes reused across calls
    phrase.lastIndex = 0;
    if (phrase.test(both)) violations.add("ai_tell");
  }
  for (const pat of TIMING_TELL_PATTERNS) {
    if (pat.test(both)) violations.add("timing_leak");
  }
  // Job J01, defense in depth: the seams strip legacy's nine timing words, so
  // copy reaching here with one means a path skipped that layer. Read outside
  // tags only, so an href token is never a leak. The body is also read with
  // its tags removed, so a phrase split by a tag ("this <b>morning</b>"),
  // which the per-part detector and the strip cannot see, still sends the
  // template.
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
  /** S27's three merchant-context fields, from `accounts`. All optional: a
   *  merchant who filled none gets no context line at all, which is legacy's
   *  behaviour and not a placeholder. */
  industry?: string | null;
  customerType?: string | null;
  mrrCents?: number | null;
  /** S31's four per-category voices, from `stripe_connections`. Each is the
   *  voice for ONE decline category; absent means "same as main voice", which
   *  is what legacy's own select labels the empty option. */
  voiceSoft?: string | null;
  voiceExpired?: string | null;
  voiceNetwork?: string | null;
  voiceFraud?: string | null;
}

/**
 * Legacy's merchant-context line, reproduced from
 * `lib/email-generation.ts:243-249` (blob `e28d780e`).
 *
 * THIS IS THE READER FOR S27's THREE COLUMNS. They had a writer on /settings and
 * no reader anywhere, under legacy's own help string "Used to personalize
 * recovery emails", so the promise was false at HEAD (336 binding 4 rules the
 * fix is the reader, not removing the fields).
 *
 * Legacy's exact shape, kept rather than improved: three optional parts joined
 * by a SPACE, prefixed "Merchant context: ", and the whole line omitted when
 * every part is absent. MRR is stored in cents and divided by 100 for the
 * prompt, as legacy divides it. `mrrCents` of 0 is falsy on both sides, so a
 * merchant reporting zero MRR contributes no part.
 */
export function merchantContextLine(merchant: MerchantBrandVoice): string | null {
  const parts: string[] = [];
  if (merchant.industry) parts.push(`${merchant.industry} business`);
  if (merchant.customerType) parts.push(`serving ${merchant.customerType} customers`);
  if (merchant.mrrCents) parts.push(`with ~$${Math.round(merchant.mrrCents / 100)}/month MRR`);
  return parts.length > 0 ? `Merchant context: ${parts.join(" ")}` : null;
}

/** Legacy's `BRAND_VOICE_DEFAULT`, byte for byte (`lib/constants.ts:21`).
 *  ALIGNED under ruling 338: this string is user-facing output in every email a
 *  merchant who sets no voice sends, and legacy is the spec for that output.
 *  Foxhound's own wording, "warm, plain, and direct; a real person from the
 *  business writing a short note", was an unratified divergence on the third
 *  rung of resolveBrandVoice. */
const DEFAULT_VOICE = "Friendly and direct. Write like a real person, not a company.";

/**
 * Resolve the brand-voice descriptor for the prompt.
 *
 * LEGACY'S ORDER, PORTED VERBATIM from `lib/email-generation.ts:38-48`
 * (blob `e28d780e`): the category's own voice, else the general voice, else a
 * constant default. Every rung uses a falsy check on both sides, so an EMPTY
 * STRING and NULL behave identically and both fall through. That is what makes
 * "Same as main voice" storable as NULL rather than needing a sentinel.
 *
 * THE CATEGORY ARGUMENT IS THE WHOLE POINT and its absence was the defect:
 * Foxhound narrowed a legacy feature to a single voice by dropping it (337
 * binding 6, removed under 324 as a Foxhound-internal narrowing).
 *
 * SIX CATEGORIES, FOUR COLUMNS, and the two extras need no decision. Legacy's
 * `switch` has a `default:` arm returning the fallback for any category it has
 * no column for, so `revoked` and `unknown` resolve to the general voice by
 * porting the switch rather than by inventing columns for them.
 */
export function resolveBrandVoice(
  merchant: MerchantBrandVoice,
  declineCategory: string,
): string {
  const general = merchant.voiceDescription?.trim();
  const fallback = general && general.length > 0 ? general : DEFAULT_VOICE;

  const categoryVoice = categoryVoiceFor(merchant, declineCategory)?.trim();
  return categoryVoice && categoryVoice.length > 0 ? categoryVoice : fallback;
}

/** The column for one category, or undefined where legacy has none. Separated
 *  so the six-against-four mapping is one readable place. */
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
      // `revoked` and `unknown` land here, as does anything unrecognised.
      return undefined;
  }
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
    `business's own voice: ${untrusted(brandVoice)}.`,
    UNTRUSTED_DATA_RULE,
    "Rules you must follow exactly:",
    "- Never use em dashes or en dashes. Use commas or short sentences.",
    "- Never mention how many days or hours it has been, or reference an internal",
    "  schedule ('day 3', '72 hours ago'). Speak only to the present.",
    // Job J01, layer 1: legacy's rule (blob `e28d780e` line 139), widened to
    // the body and to all nine phrases its detector and quality check name.
    "- Never use timing words like 'today', 'tonight', 'yesterday', 'this morning',",
    "  'this afternoon', 'this evening', 'right now', 'immediately' or 'by end of day'",
    "  in the subject or the body. You do not know when the customer will read this.",
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

export function buildUserPrompt(input: GenerateEmailInput): string {
  const guidance = categoryGuidance(input.declineCategory);
  // Exported so a plant can observe the prompt the model actually receives.
  // The merchant-context line is the OUTPUT of S27's reader: without it the
  // three columns reach nothing.
  const merchantContext = merchantContextLine(input.merchant);
  return [
    `Business: ${untrusted(input.merchant.merchantName)}`,
    merchantContext ? untrusted(merchantContext) : "",
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
/**
 * The exact prompt pair `generateDunningEmail` sends. PURE and exported so the
 * brand-voice resolution is observable: the resolved voice lands in the SYSTEM
 * string, not the user string, so a plant reading only the user prompt would
 * miss it entirely. 337 binding 4: reach the real assembly, do not rebuild it
 * in the test.
 */
export function buildPrompts(input: GenerateEmailInput): { system: string; user: string } {
  return {
    system: buildSystemPrompt(resolveBrandVoice(input.merchant, input.declineCategory)),
    user: buildUserPrompt(input),
  };
}

export async function generateDunningEmail(
  env: Env,
  input: GenerateEmailInput,
): Promise<EmailCopy> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const client = createAnthropicClient(env);
  const prompts = buildPrompts(input);

  // One call shape for the first call and the timing-word retry: the retry is
  // the same system and user prompt with legacy's instruction appended.
  const call = async (instruction = ""): Promise<EmailCopy> => {
    const response = await client.messages.create({
      model: MODEL_RECOVERY_EMAIL,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      system: prompts.system,
      messages: [{ role: "user", content: prompts.user + instruction }],
    });
    return readGeneratedCopy(response, "recovery email");
  };

  // Job J01, layers 3 and 4 (legacy recovery-execution.ts blob `3a8f8768`
  // lines 313 to 351).
  return applyTimingWordGuard(await call(), call);
}
