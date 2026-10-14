import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DOC_GUIDES, type DocBlock, type DocInline } from "~/lib/marketing/docs-content";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

// 376 ITEM 19: TWO FALSE CLAUSES IN THE HOME FAQ.
//
// The answer to "Can I see what the emails look like before they send?" read
// "Every generated email is visible in your dashboard before and after it sends
// ... You can customize your brand voice, or write your own subject lines."
// Verified false at 2569400 in both halves:
//
//   BEFORE IT SENDS. There is no draft. Emails are written at send time from the
//   customer, the decline and the brand voice, which the recovery guide states
//   in its own words, so there is nothing to look at beforehand.
//
//   WRITE YOUR OWN SUBJECT LINES. No route writes a custom subject. The control
//   does not exist anywhere in the product.
//
// The question stays, because merchants really do ask it. The answer now says
// no, and says what IS true instead. Class (c) truthfulness under 362.
//
// THE PLANT PINS THE CLAIM, NOT A PHRASE, and where it pins words those words
// ARE the claim: "before and after it sends" and "write your own subject lines"
// are the two false assertions themselves, so their absence is the fix.

describe("PLANT 1: the two false clauses are gone", () => {
  const home = read("app/routes/home.tsx");

  it("the FAQ no longer promises a preview before sending", () => {
    expect(home.length).toBeGreaterThan(1000);
    expect(home).not.toContain("before and after it sends");
  });

  it("and no longer offers custom subject lines", () => {
    expect(home).not.toContain("write your own subject lines");
    expect(home.toLowerCase()).not.toContain("own subject line");
  });

  it("NO SURFACE ANYWHERE offers a custom subject line", () => {
    // Swept rather than checked on one page, because the claim was wrong about
    // the product and not about home: if the control does not exist, no surface
    // may offer it.
    for (const file of [
      "app/routes/home.tsx",
      "app/routes/pricing.tsx",
      "app/lib/marketing/docs-content.ts",
    ]) {
      const src = read(file);
      expect(src.length, `${file} read empty`).toBeGreaterThan(500);
      expect(src.toLowerCase(), `${file} offers a custom subject`).not.toContain("subject lines");
    }
  });

  it("/features names AI-written subject lines and offers no custom one", () => {
    // /features moved its copy to lib/marketing/features-content.ts (J60) and
    // carries Recova's entry "AI-written subject lines", which is true: the
    // generator writes every subject. So this checks the claim itself, a
    // subject line the merchant writes, rather than the bare phrase.
    const src = read("app/lib/marketing/features-content.ts").toLowerCase();
    expect(src.length).toBeGreaterThan(500);
    expect(src).toContain("ai-written subject lines");
    for (const claim of ["own subject line", "custom subject", "write your own", "edit the subject"]) {
      expect(src, `/features offers "${claim}"`).not.toContain(claim);
    }
  });
});

describe("PLANT 2: the replacement agrees with the docs", () => {
  /** The docs' own sentence on this, which is the claim the FAQ must not
   *  contradict. Read from DOC_GUIDES so the two cannot drift apart. */
  function guideText(slug: string): string {
    const flattenInline = (node: DocInline): string =>
      typeof node === "string"
        ? node
        : "code" in node
          ? node.code
          : "strong" in node
            ? node.strong
            : "mono" in node
              ? node.mono
              : node.link;
    const rich = (r: string | DocInline[]) => (typeof r === "string" ? r : r.map(flattenInline).join(""));
    const flatten = (blocks: DocBlock[]): string =>
      blocks
        .map((b) => {
          if (typeof b === "string") return b;
          switch (b.kind) {
            case "p":
              return rich(b.body);
            case "h3":
              return b.text;
            case "note":
            case "tip":
              return rich(b.body);
            case "steps":
            case "list":
              return b.items.map(rich).join(" ");
            case "table":
              return [...b.columns, ...b.rows.flat().map(rich)].join(" ");
            case "widget":
              return b.name;
          }
        })
        .join("\n");
    const guide = DOC_GUIDES.find((g) => g.slug === slug);
    if (!guide) throw new Error(`no guide ${slug}`);
    return guide.sections.map((s) => flatten(s.body)).join("\n");
  }

  it("the docs still say there is no draft to edit, which is what the FAQ now echoes", () => {
    const recovery = guideText("recovery");
    expect(recovery.length).toBeGreaterThan(2000);
    expect(recovery).toContain("no rewrite-the-pending-email control");
    expect(recovery).toContain("written at send time");
  });

  it("and the FAQ answer says the same thing in its own words", () => {
    const home = read("app/routes/home.tsx");
    expect(home).toContain("written at send time");
    expect(home).toContain("no draft sitting there to preview");
    // The half that stays TRUE and must not be lost in the correction: a sent
    // email is visible, and the tracking that matters for billing is clicks.
    expect(home).toContain("visible in your dashboard afterwards");
    expect(home).toContain("click tracking");
  });
});
