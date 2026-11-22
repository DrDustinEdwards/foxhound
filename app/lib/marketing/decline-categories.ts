import type { DeclineCategory } from "~/lib/constants";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";
import { listText } from "capsomer/behavior/hooks";

// The decline-category count and names for marketing copy, derived from the engine. The count is
// `Object.keys(RECOVERY_SCHEDULES).length`, so a seventh category cannot be added while pages keep claiming six, and the names
// are a `Record<DeclineCategory, string>`, so a new key fails to compile until its customer-facing word is written.

/** The customer-facing word for each category: short, because these appear mid-sentence (the fuller
 *  `DECLINE_CATEGORY_LABELS` in ~/lib/recovery/labels.ts serves the app and is deliberately not reused). */
const MARKETING_CATEGORY_WORDS: Record<DeclineCategory, string> = {
  soft: "soft declines",
  network: "network errors",
  expired: "expired cards",
  fraud: "suspected fraud",
  revoked: "revoked authorizations",
  unknown: "declines nothing has mapped",
};

/** Number words ("Six decline categories"); outside the range the engine could occupy it falls back to digits (countWord). */
const COUNT_WORDS: Record<number, string> = {
  1: "One",
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
  7: "Seven",
  8: "Eight",
};

export function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/** How many categories the engine actually schedules. The number, everywhere. */
export const DECLINE_CATEGORY_COUNT = Object.keys(RECOVERY_SCHEDULES).length;

/** How long a recovery sequence runs, in days: the last step of the longest schedule (email_day30, 720 hours), so "N-day
 *  sequences" is read from the schedule, not typed. */
export const RECOVERY_SEQUENCE_DAYS = Math.round(
  Math.max(
    ...Object.values(RECOVERY_SCHEDULES).flatMap((steps) => steps.map((s) => s.offsetHours)),
  ) / 24,
);

/** How many different step sequences the engine runs; two categories can share one schedule (expired and unknown do), so never
 *  assumed to equal DECLINE_CATEGORY_COUNT. */
export const DISTINCT_SEQUENCE_COUNT = new Set(
  Object.values(RECOVERY_SCHEDULES).map((steps) => JSON.stringify(steps)),
).size;

export const DECLINE_CATEGORY_COUNT_WORD = countWord(DECLINE_CATEGORY_COUNT);

export const DECLINE_CATEGORY_COUNT_WORD_LOWER = DECLINE_CATEGORY_COUNT_WORD.toLowerCase();

/** The categories in reading order (the schedule's own key order, so the sentence matches the dispatch table), Oxford-comma'd with a trailing "or". */
const CATEGORY_WORDS = (Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[]).map(
  (key) => MARKETING_CATEGORY_WORDS[key],
);
export const DECLINE_CATEGORY_PHRASE = listText(CATEGORY_WORDS, "or");

/** The same categories joined with "and", for a sentence listing what the engine classifies. */
export const DECLINE_CATEGORY_LIST_AND = listText(CATEGORY_WORDS);
