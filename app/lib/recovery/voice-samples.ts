// The merchant's own past emails, pasted on /settings/brand-voice, that recovery
// and win-back drafts are written from. Examples carry a voice far better than a
// description of it does, so these sit beside the tone presets rather than
// replacing them. A recorded difference from Recova, which had the tone box only
// (parity/APPROVED-DIFFERENCES.md, 2026-10-24).
//
// Stored as one JSON array of strings in `stripe_connections.brand_voice_samples`,
// NULL when there are none. Read leniently: anything that is not an array of
// strings reads as no samples, so a bad row costs the voice, never a send.

import { untrusted } from "~/lib/ai/untrusted";

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
