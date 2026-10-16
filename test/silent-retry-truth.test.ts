import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
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

const APP = fileURLToPath(new URL("../app", import.meta.url));

/** A sentence claiming a retry comes before any email. */
const CLAIMS: RegExp[] = [
  /\b(silent|quiet)(ly)?[- ]retr(y|ies)\b.*\b(first|before|ahead of)\b/,
  /\bretr(y|ies|ied)\b.*\b(silently|quietly)\b.*\bfirst\b/,
  /\bretr(y|ies)\b.*\bbefore any (customer[- ])?(facing )?(customer )?(ever sees an )?email/,
  /\bretr(y|ies)\b.*\bahead of the first email\b/,
];

/** A sentence saying a retry does NOT happen is not a claim that one does. */
const NEGATION = /\b(rather than|instead of|no|not) a silent retry\b/;

/**
 * The scoping phrases copy actually uses to say which declines get the retry.
 * A whole phrase, not a bare word: "soft", "network" or "where" alone can sit
 * in a sentence that still claims every decline ("every decline, soft or
 * hard, gets a silent retry first").
 */
const QUALIFIERS: RegExp[] = [
  /\bwherever the decline can be retried\b/,
  /\bwhere the decline allows a retry\b/,
  /\bwhere the category allows one\b/,
  /\bwhere a retry can work\b/,
  /\bwhere retryable\b/,
  /\bwhen a retryable payment fails\b/,
  /\bfor a soft or network decline\b/,
  /^a soft decline gets\b/,
];

/** Words that widen a claim back to every decline, whatever else it says. */
const EVERY = /\b(every|all|any) (decline|declines|failed payment|failed payments|payment)\b|\bhard\b/;

const isScoped = (s: string) => !EVERY.test(s) && QUALIFIERS.some((re) => re.test(s));

// Sentences whose scope comes from where they sit, not from their own words.
// Each entry is a file and a fragment of the sentence.
const SCOPED_BY_CONTEXT: Array<[string, string, string]> = [
  // The `soft` row of the sequences page's per-category descriptions (moved
  // from the route to its own module by J12).
  ["lib/recovery/sequence-categories.ts", "foxhound retries silently first", "soft row"],
  // The soft/network branch (retryable === true) of the per-code explainer.
  ["lib/decline-codes/presentation.ts", "silent retry runs first", "retryable branch"],
  // The answer to "Why does network get an early retry?" in the docs.
  ["lib/marketing/docs-content.ts", "the early retry catches those before any email", "network answer"],
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** Every piece of literal text in a source file, comments excluded. */
function literalTexts(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      // JSX wraps a sentence across source lines; the reader sees one line.
      out.push(node.text.replace(/\s+/g, " "));
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("N"));
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

function sentences(text: string): string[] {
  return text
    .toLowerCase()
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const isClaim = (s: string) => !NEGATION.test(s) && CLAIMS.some((re) => re.test(s));

describe("silent retry copy matches the engine", () => {
  it("the engine leads with a retry for some categories and an email for others", () => {
    const lead = Object.entries(RECOVERY_SCHEDULES).map(([c, s]) => [c, isRetryStep(s[0]!.stepType)] as const);
    expect(lead.filter(([, r]) => r).length).toBeGreaterThan(0);
    expect(lead.filter(([, r]) => !r).length).toBeGreaterThan(0);
    for (const [category, retryFirst] of lead) {
      expect(retryFirst, category).toBe(isRetryable(category as Parameters<typeof isRetryable>[0]));
    }
  });

  it("a scoping word does not excuse a sentence that still claims every decline", () => {
    const planted = "every decline, soft or hard, gets a silent retry first.";
    expect(isClaim(planted)).toBe(true);
    expect(isScoped(planted)).toBe(false);
    expect(isScoped("a silent retry runs first where the network is up.")).toBe(false);
    expect(isScoped("a silent retry runs first, wherever the decline can be retried.")).toBe(true);
  });

  it("no copy under app/ says a silent retry comes first without naming which declines", () => {
    const offenders: string[] = [];
    for (const file of walk(APP)) {
      const rel = relative(APP, file).replaceAll("\\", "/");
      if (rel === "lib/decline-codes/content.ts") continue; // per-code, checked below
      for (const text of literalTexts(file)) {
        for (const s of sentences(text)) {
          if (!isClaim(s) || isScoped(s)) continue;
          if (SCOPED_BY_CONTEXT.some(([f, frag]) => f === rel && s.includes(frag))) continue;
          offenders.push(`${rel}: ${s}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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
