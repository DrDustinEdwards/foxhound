import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DocBlocks } from "~/components/docs/doc-blocks";
import { DOC_GUIDES, type DocBlock } from "~/lib/marketing/docs-content";

// SESSION 64, JOB 1: legacy's docs block vocabulary, at legacy's treatment.
//
// EVERY CLASS LIST BELOW IS READ FROM LEGACY SOURCE, not invented: the Part, H3,
// P, Note, Tip, Steps, Step, List, Item, Code, Strong and RelLink helpers at the
// bottom of `app/(marketing)/docs/platform/page.tsx` (blob `2b69517b`) and
// `.../recovery/page.tsx` (blob `6166a6be`), which declare them identically.
//
// TWO SUBSTITUTIONS, both named rather than silent: `text-[0.9375rem]` and
// `text-[0.8125rem]` become `text-item-title` and `text-label`, which are those
// exact values in app.css and are what check-tokens requires; and
// `flex-shrink-0` becomes `shrink-0`, the Tailwind v4 spelling of one rule.

function render(blocks: DocBlock[]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DocBlocks, { blocks })),
  );
}

describe("PLANT 1: a plain string is still a paragraph, unchanged", () => {
  it("renders at the treatment the twelve shipped sections already had", () => {
    // The pre-extension renderer emitted exactly this. A schema extension that
    // moved it would have silently restyled every sentence sessions 42 to 60
    // shipped.
    expect(render(["Hello."])).toBe(
      '<p class="mb-4 text-item-title leading-relaxed text-text-secondary">Hello.</p>',
    );
  });

  it("ALL FIVE GUIDES ARE AUTHORED, and the plain-string form is still in use", () => {
    // PART TWO CHANGED THIS ON PURPOSE, which part one's version of this test
    // said in as many words: it pinned the three unauthored guides at eight
    // plain strings so that authoring them would have to come here and say so.
    //
    // What it pins now is the property that outlives both parts: every guide
    // carries rich blocks, AND plain strings are still a live form rather than
    // a legacy path nothing exercises.
    const blocks = DOC_GUIDES.flatMap((g) => g.sections).flatMap((s) => s.body);
    expect(DOC_GUIDES).toHaveLength(5);
    expect(blocks.length).toBeGreaterThan(150);
    expect(blocks.some((b) => typeof b === "string")).toBe(true);
    expect(blocks.some((b) => typeof b !== "string")).toBe(true);
    for (const guide of DOC_GUIDES) {
      const rich = guide.sections.flatMap((s) => s.body).filter((b) => typeof b !== "string");
      expect(rich.length, `${guide.slug} carries no rich blocks`).toBeGreaterThan(0);
    }
  });
});

describe("PLANT 2: each block type renders at legacy's geometry", () => {
  it("H3", () => {
    expect(render([{ kind: "h3", text: "Sender name" }])).toBe(
      '<h3 class="mb-3 mt-8 text-item-title font-medium text-text">Sender name</h3>',
    );
  });

  it("NOTE, with its own border-border rail and its Note. label", () => {
    const html = render([{ kind: "note", body: "Careful." }]);
    expect(html).toContain(
      'class="my-4 border-l-2 border-border pl-4 text-label leading-relaxed text-text-secondary"',
    );
    expect(html).toContain('<span class="font-medium text-text">Note.</span> Careful.');
  });

  it("TIP, which differs from Note ONLY in its rail colour and its label", () => {
    const html = render([{ kind: "tip", body: "Try this." }]);
    expect(html).toContain(
      'class="my-4 border-l-2 border-brand pl-4 text-label leading-relaxed text-text-secondary"',
    );
    expect(html).toContain('<span class="font-medium text-text">Tip.</span> Try this.');
    // BOTH DIRECTIONS: a Tip that rendered the Note rail would pass the colour
    // assertion above only by accident of ordering, so the wrong one is excluded.
    expect(html).not.toContain("border-border");
  });

  it("STEPS, numbered zero-padded from the index", () => {
    const html = render([{ kind: "steps", items: ["First.", "Second."] }]);
    expect(html).toContain('<ol class="my-4 space-y-3">');
    expect(html).toContain('class="flex gap-3 text-item-title leading-relaxed text-text-secondary"');
    expect(html).toContain('<span class="shrink-0 font-mono text-brand-text">01</span>');
    expect(html).toContain('<span class="shrink-0 font-mono text-brand-text">02</span>');
  });

  it("LIST", () => {
    const html = render([{ kind: "list", items: ["One.", "Two."] }]);
    expect(html).toContain(
      '<ul class="my-4 list-inside list-disc space-y-2 text-item-title leading-relaxed text-text-secondary">',
    );
    expect(html).toContain("<li>One.</li>");
  });

  it("TABLE, at any column count, because legacy ships both two and three", () => {
    const html = render([
      {
        kind: "table",
        columns: ["Metric", "What it measures", "Where"],
        rows: [["Open rate", "Emails opened at least once", "Sequences"]],
      },
    ]);
    expect(html).toContain('<div class="my-6 overflow-x-auto"><table class="w-full text-label">');
    expect(html).toContain('<tr class="border-b border-border">');
    expect(html).toContain('<th class="py-2 pr-4 text-left font-medium text-text">Metric</th>');
    expect(html).toContain('<tbody class="text-text-secondary">');
    expect(html).toContain('<td class="py-2 pr-4">Open rate</td>');
  });
});

describe("PLANT 3: the inline vocabulary", () => {
  it("CODE, STRONG and a bare font-mono span", () => {
    const html = render([
      {
        kind: "p",
        body: [
          { strong: "Recovery." },
          " Fires on ",
          { code: "invoice.payment_succeeded" },
          " at ",
          { mono: "30d" },
          ".",
        ],
      },
    ]);
    expect(html).toContain('<strong class="font-medium text-text">Recovery.</strong>');
    expect(html).toContain(
      '<code class="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-label">invoice.payment_succeeded</code>',
    );
    expect(html).toContain('<span class="font-mono">30d</span>');
  });

  it("A RELLINK TO AN IN-APP PATH ROUTES THROUGH Link, so the shell is not torn down", () => {
    const html = render([
      { kind: "p", body: [{ link: "the Recovery guide", to: "/docs/recovery" }] },
    ]);
    // `data-discover` is React Router's own marker on a rendered Link, so its
    // presence is what distinguishes this branch from the plain anchor below
    // rather than the class list, which the two share.
    expect(html).toContain(
      '<a class="text-brand-text underline underline-offset-2" href="/docs/recovery" data-discover="true">the Recovery guide</a>',
    );
  });

  it("AND A MAILTO IS A PLAIN ANCHOR, which is what legacy does for support", () => {
    // Rendering a mailto through Link would produce a relative path and a dead
    // link. Legacy writes a bare <a> for exactly this case.
    const html = render([
      { kind: "p", body: [{ link: "support", to: "mailto:support@foxhoundapp.com" }] },
    ]);
    expect(html).toContain('href="mailto:support@foxhoundapp.com"');
    expect(html).toContain('class="text-brand-text underline underline-offset-2"');
    expect(html).not.toContain("data-discover");
  });
});
