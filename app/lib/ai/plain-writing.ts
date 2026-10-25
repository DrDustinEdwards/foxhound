// Plain writing for every model-written text Foxhound shows or sends: recovery
// and win-back emails, dispute evidence, the Intelligence narrative, the audit
// summary and the home page's email sample. The check and the rules are
// site-runtime ./prose's, the family's one prose check, which Carrel runs on
// AI drafts too. An approved difference from Recova (Dustin, 2026-10-24,
// parity/APPROVED-DIFFERENCES.md).
//
// Only high and critical findings count: the phrases and words current models
// still write ("no hard feelings", "genuinely", "great question"), from
// site-runtime's tested lists. The medium ones (a dash, "not X, it's Y") and a
// list of three are the prompt's to prevent, and a retry over one would cost
// more than the phrase does.

import { checkProse, WRITING_RULES, type ProseIssue } from "@dustinedwards/site-runtime/prose";

/** The family's plain-writing rules as prompt lines. Its line on headings is
 *  about blog posts and is left out. */
export const PLAIN_WRITING_LINES: readonly string[] = WRITING_RULES.split("\n").filter(
  (line) => line.startsWith("- ") && !/headings/i.test(line),
);

/** The lines a prompt carries: a heading, then the rules. */
export const PLAIN_WRITING_PROMPT = ["Plain writing:", ...PLAIN_WRITING_LINES].join("\n");

/** The stock phrasing in a text that a reader notices at once, less any
 *  phrase in `allow`. Pure. */
export function findStockPhrasing(text: string, allow: readonly string[] = []): ProseIssue[] {
  return checkProse(text, { allow: [...allow] }).filter(
    (i) => i.severity === "high" || i.severity === "critical",
  );
}

/**
 * The stock phrases the merchant's own emails use. Those are their voice, so a
 * draft that matches them is never retried for it. Pure.
 */
export function ownPhrasing(samples: readonly string[]): string[] {
  return [...new Set(samples.flatMap((s) => findStockPhrasing(s).flatMap((i) => (i.excerpt ? [i.excerpt] : []))))];
}

/** The retry's instruction, naming what the first draft used. */
export function stockPhrasingInstruction(issues: readonly ProseIssue[]): string {
  const named = [...new Set(issues.map((i) => (i.excerpt ? `"${i.excerpt}"` : i.message)))].join(", ");
  return `\n\nADDITIONAL INSTRUCTION:\nThe previous draft used phrasing that reads as machine-written: ${named}. Write it again in plain words, without them.`;
}

/**
 * One retry when the first draft carries stock phrasing, kept only if it has
 * less and still says something. Never more than one extra call, and a failed
 * retry keeps the first draft, so the check can cost a call but never a text.
 */
export async function retryStockPhrasing<T>(
  first: T,
  textOf: (draft: T) => string,
  retry: (instruction: string) => Promise<T>,
  allow: readonly string[] = [],
): Promise<T> {
  const issues = findStockPhrasing(textOf(first), allow);
  if (issues.length === 0) return first;
  try {
    const retried = await retry(stockPhrasingInstruction(issues));
    const text = textOf(retried);
    if (text.trim() && findStockPhrasing(text, allow).length < issues.length) return retried;
  } catch (err) {
    // The message only: an SDK error object can carry request details.
    console.error("stock-phrasing retry failed; keeping the first draft:", err instanceof Error ? err.message : "unknown error");
  }
  return first;
}
