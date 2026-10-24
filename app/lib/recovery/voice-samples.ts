// The merchant's own past emails, pasted on /settings/brand-voice, that recovery
// and win-back drafts are written from. Examples carry a voice far better than a
// description of it does, so these sit beside the tone presets rather than
// replacing them. A recorded difference from Recova, which had the tone box only
// (parity/APPROVED-DIFFERENCES.md, 2026-10-24).
//
// Stored as one JSON array of strings in `stripe_connections.brand_voice_samples`,
// NULL when there are none. Read leniently: anything that is not an array of
// strings reads as no samples, so a bad row costs the voice, never a send.

import { copiedRuns } from "@dustinedwards/site-runtime/prose";
import { untrusted } from "~/lib/ai/untrusted";
import { hrefsIn } from "~/lib/recovery/update-link";

/** The form's five boxes. Two or three is plenty; five is the most a prompt carries. */
export const MAX_VOICE_SAMPLES = 5;
/** One sample's length in characters: a long newsletter is cut, not refused. */
export const VOICE_SAMPLE_MAX_CHARS = 3000;

/** The form field for sample `i` (0-based). */
export function voiceSampleFieldName(i: number): string {
  return `voice_sample_${i + 1}`;
}

/** The stored column, read back as up to five non-empty samples. */
export function readVoiceSamples(stored: string | null | undefined): string[] {
  if (!stored) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return cleanVoiceSamples(parsed);
}

/** Trimmed, non-empty strings, each cut to the length limit, at most five. */
export function cleanVoiceSamples(samples: readonly unknown[]): string[] {
  return samples
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().slice(0, VOICE_SAMPLE_MAX_CHARS).trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_VOICE_SAMPLES);
}

/** The value to store: the JSON array, or NULL when every box is empty. */
export function storeVoiceSamples(samples: readonly unknown[]): string | null {
  const clean = cleanVoiceSamples(samples);
  return clean.length > 0 ? JSON.stringify(clean) : null;
}

/**
 * The prompt lines that carry the samples, or none. Each sample is merchant
 * text, so it goes in as untrusted data: the model copies how it reads, never
 * what it says or asks.
 */
export function voiceSampleLines(samples: readonly string[]): string[] {
  if (samples.length === 0) return [];
  return [
    "Emails this business has written itself. Match how they read: their length, greeting, sign-off,",
    "contractions and sentence rhythm. Never copy their facts, offers, names or links.",
    ...samples.map((s, i) => `Sample ${i + 1}: ${untrusted(s)}`),
  ];
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * What a draft says that it was never given, in the order found: a link or web
 * address other than `url` (the one link the prompt hands it), an email
 * address, or a run of eight or more words copied from a sample. The prompt
 * forbids all three; this is what makes that hold, because a pasted email can
 * carry an old offer, a customer's name or "add this payment link". A draft
 * with any of them sends the template. Pure.
 */
export function strayContent(bodyHtml: string, text: string, samples: readonly string[], url: string): string[] {
  const out: string[] = [];
  for (const href of hrefsIn(bodyHtml)) if (href !== url) out.push(`link ${href}`);
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const address = m[0].replace(/[.,;:!?)]+$/, "");
    if (address !== url) out.push(`address ${address}`);
  }
  for (const m of text.matchAll(EMAIL_IN_TEXT)) out.push(`email address ${m[0]}`);
  for (const run of copiedRuns(text, [...samples])) out.push(`copied "${run}"`);
  return out;
}
