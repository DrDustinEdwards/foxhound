import type { DeclineCategory } from "~/lib/constants";
import { RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";

// THE DECLINE-CATEGORY COUNT AND NAMES, FOR MARKETING COPY, DERIVED FROM THE
// ENGINE (376 item 18).
//
// WHY THIS EXISTS. Four marketing surfaces said "four decline categories"
// against an engine that ships six: /pricing, home, /features and the
// competitor comparison. 359 already found and fixed the same sentence in the
// DOCS and fixed it by DERIVING the set, so the docs have said six since. The
// marketing copy was left behind and went on saying four for as long.
//
// Legacy's marketing says four about a six-key engine too, so this is a
// truthfulness fix rather than a divergence: class (c) under 362, no parity
// ratification needed, and the sentence structure is untouched so no layout or
// treatment moves.
//
// ONE SOURCE, AND IT IS THE SCHEDULE TABLE. The count is
// `Object.keys(RECOVERY_SCHEDULES).length`, so a seventh category cannot be
// added to the engine while the marketing pages keep claiming six. The names are
// a `Record<DeclineCategory, string>`, which means adding that seventh key does
// not merely fail a test, it fails to COMPILE until somebody writes the word a
// customer should read for it.

/** The customer-facing word for each category. Short and plain, because these
 *  appear mid-sentence in marketing copy rather than as table labels; the
 *  fuller `DECLINE_CATEGORY_LABELS` in ~/lib/recovery/labels.ts serves the app's
 *  own surfaces and is deliberately not reused here. */
const MARKETING_CATEGORY_WORDS: Record<DeclineCategory, string> = {
  soft: "soft declines",
  network: "network errors",
  expired: "expired cards",
  fraud: "suspected fraud",
  revoked: "revoked authorizations",
  unknown: "declines nothing has mapped",
};

/** Number words, so copy reads "Six decline categories" rather than "6". Only
 *  the range the engine could plausibly occupy is spelled; anything outside it
 *  falls back to the digits rather than inventing a word (countWord). */
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

/** A count as its capitalized word ("Six"), or its digits outside COUNT_WORDS. */
export function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/** How many categories the engine actually schedules. THE number, everywhere. */
export const DECLINE_CATEGORY_COUNT = Object.keys(RECOVERY_SCHEDULES).length;

/**
 * How long a recovery sequence runs, in days: the last step of the longest
 * schedule the engine dispatches (email_day30 today, 720 hours). This is what
 * "N-day sequences" and "across N days" describe, so it is read from the
 * schedule rather than typed beside it. It sits beside the category count so
 * every marketing carrier can take both from one place.
 */
export const RECOVERY_SEQUENCE_DAYS = Math.round(
  Math.max(...Object.values(RECOVERY_SCHEDULES).flatMap((steps) => steps.map((s) => s.offsetHours))) / 24,
);

/**
 * How many different step sequences the engine runs. Two categories can share
 * one schedule (expired and unknown do today), so this is read from the
 * schedules, never assumed to equal DECLINE_CATEGORY_COUNT.
 */
export const DISTINCT_SEQUENCE_COUNT = new Set(
  Object.values(RECOVERY_SCHEDULES).map((steps) => JSON.stringify(steps)),
).size;

/** Capitalized, for the head of a sentence. */
export const DECLINE_CATEGORY_COUNT_WORD = countWord(DECLINE_CATEGORY_COUNT);

/** Lower case, for mid-sentence use. */
export const DECLINE_CATEGORY_COUNT_WORD_LOWER = DECLINE_CATEGORY_COUNT_WORD.toLowerCase();

/**
 * The categories named in reading order, Oxford-comma'd with a trailing "or".
 *
 * Ordered by the SCHEDULE's own key order rather than alphabetically, so the
 * sentence a customer reads and the table the engine dispatches on are in the
 * same order.
 */
export const DECLINE_CATEGORY_PHRASE = (() => {
  const words = (Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[]).map(
    (key) => MARKETING_CATEGORY_WORDS[key],
  );
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")}, or ${words[words.length - 1]}`;
})();

/**
 * The same categories joined with "and", for a sentence that lists what the
 * engine classifies (Recova's home comparison row: "soft decline, insufficient
 * funds, and expired card") rather than which one a payment falls in.
 */
export const DECLINE_CATEGORY_LIST_AND = (() => {
  const words = (Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[]).map(
    (key) => MARKETING_CATEGORY_WORDS[key],
  );
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
})();
