
import { describe, expect, it } from "vitest";

import { DECLINE_CONTENT } from "~/lib/decline-codes/content";
import { classifyDecline, isRetryable } from "~/lib/recovery/decline";
import { isEmailStep, isRetryStep, RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";

// Copy must not say every failed payment gets a silent retry before the first
// email. The engine (app/lib/recovery/schedule.ts, RECOVERY_SCHEDULES) leads
// with a retry only for the categories isRetryable() names (soft, network);
// expired, fraud, revoked and unknown lead with an email. A sentence that
// claims retry-before-email is true only when it says which declines it means.
//
// Scope is every string literal, template literal and JSX text under app/.
// Comments are not copy and are not read.


/** A sentence claiming a retry comes before any email. */
const CLAIMS: RegExp[] = [
  /\b(silent|quiet)(ly)?[- ]retr(y|ies)\b.*\b(first|before|ahead of)\b/,
  /\bretr(y|ies|ied)\b.*\b(silently|quietly)\b.*\bfirst\b/,
  /\bretr(y|ies)\b.*\bbefore any (customer[- ])?(facing )?(customer )?(ever sees an )?email/,
  /\bretr(y|ies)\b.*\bahead of the first email\b/,
];

/** A sentence saying a retry does NOT happen is not a claim that one does. */
const NEGATION = /\b(rather than|instead of|no|not) a silent retry\b/;




// Sentences whose scope comes from where they sit, not from their own words.
// Each entry is a file and a fragment of the sentence.



function sentences(text: string): string[] {
  return text
    .toLowerCase()
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}


describe("silent retry copy matches the engine", () => {
  it("the engine leads with a retry for some categories and an email for others", () => {
    const lead = Object.entries(RECOVERY_SCHEDULES).map(([c, s]) => [c, isRetryStep(s[0]!.stepType)] as const);
    expect(lead.filter(([, r]) => r).length).toBeGreaterThan(0);
    expect(lead.filter(([, r]) => !r).length).toBeGreaterThan(0);
    for (const [category, retryFirst] of lead) {
      expect(retryFirst, category).toBe(isRetryable(category as Parameters<typeof isRetryable>[0]));
    }
  });

  it("a decline-code page claims a retry only for a code the engine retries", () => {
    // Phrases that say Foxhound retries this code; true only for soft/network.
    const RETRY_CLAIMS = [
      ...CLAIMS,
      /\bsafe to retry\b/,
      /\bhandled as retryable\b/,
      /\bretry is the appropriate first step\b/,
      /\bdefault category, which is soft\b/,
    ];
    const offenders: string[] = [];
    for (const [code, entry] of Object.entries(DECLINE_CONTENT)) {
      if (isRetryable(classifyDecline(code))) continue;
      const texts = [entry.meaning, entry.whyItHappens, entry.howToFix, ...entry.faqs.flatMap((f) => [f.question, f.answer])];
      for (const s of texts.flatMap(sentences)) {
        if (!NEGATION.test(s) && RETRY_CLAIMS.some((re) => re.test(s))) offenders.push(`${code}: ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a decline-code page never says Foxhound suppresses the emails its category's schedule sends", () => {
    const SUPPRESSES = /\b(suppress\w*|skips?|stops?|pauses?)\b.*\b(email|emails|dunning)\b/;
    const NAMES_FOXHOUND = /\b(foxhound|bucket)\b/;
    const offenders: string[] = [];
    for (const [code, entry] of Object.entries(DECLINE_CONTENT)) {
      const steps = RECOVERY_SCHEDULES[classifyDecline(code)];
      if (!steps.some((s) => isEmailStep(s.stepType))) continue;
      const texts = [entry.meaning, entry.whyItHappens, entry.howToFix, ...entry.faqs.flatMap((f) => [f.question, f.answer])];
      for (const s of texts.flatMap(sentences)) {
        if (NAMES_FOXHOUND.test(s) && SUPPRESSES.test(s)) offenders.push(`${code}: ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
