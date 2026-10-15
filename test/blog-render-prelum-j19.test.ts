import { runConformance } from "@drdustinedwards/site-helpers/render/conformance";
import { describe, expect, it } from "vitest";

import { blogPosts } from "~/db";
import type { Db } from "~/db";
import { extractFaqPairs } from "~/lib/blog/faq";
import { excerptText, renderBlogMarkdown, renderPostBody, withRenderedExcerpts } from "~/lib/blog/render.server";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J19 (job_deffd581af37), DO step 3: post bodies and excerpts render through
// Prelum's `render` (Q2) with a Foxhound render pack that carries Recova's
// ::postlink and :::diagram meaning (Recova lib/markdown.ts, blob 62a2e55c).
// Each case below names the Recova behaviour it holds the new renderer to.

const PUBLISHED = new Map([
  ["dunning-email-sequence", { slug: "dunning-email-sequence", title: "How to Write a Dunning Email Sequence" }],
  ["stripe-decline-codes", { slug: "stripe-decline-codes", title: "Every Stripe Decline Code, Explained" }],
]);

const render = (body: string) => renderBlogMarkdown(body, { postLinks: PUBLISHED });

describe("post bodies render through Prelum (J19)", () => {
  it("emits Prelum's output: a heading anchor and Prelum's table wrapper", async () => {
    const { html } = await render("## Retry timing\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain('class="heading-anchor"');
    expect(html).toContain('<div class="table-scroll" tabindex="0"><table>');
  });

  it("keeps Recova's heading ids, so every TOC anchor and deep link stays where it was", async () => {
    const { html, toc } = await render("## Timing & deadlines\n\nx\n\n### What's a soft decline?\n\ny\n\n## Timing & deadlines\n\nz");
    // Recova slugged the heading's HTML, so "&" became "amp". Prelum's own
    // slugger would write "timing--deadlines" and "timing--deadlines-1".
    expect(toc).toEqual([
      { level: 2, text: "Timing & deadlines", id: "timing-amp-deadlines" },
      { level: 3, text: "What's a soft decline?", id: "whats-a-soft-decline" },
      { level: 2, text: "Timing & deadlines", id: "timing-amp-deadlines-2" },
    ]);
    expect(html).toContain('<h2 id="timing-amp-deadlines">');
    expect(html).toContain('<h2 id="timing-amp-deadlines-2">');
  });

  it("resolves an inline ::postlink to the published post's current title", async () => {
    const { html } = await render("See ::postlink[dunning-email-sequence] for the emails.");
    expect(html).toContain('See <a href="/blog/dunning-email-sequence">How to Write a Dunning Email Sequence</a> for the emails.');
  });

  it("uses a ::postlink's own anchor text after the bar", async () => {
    const { html } = await render("Read ::postlink[stripe-decline-codes|the full reference] first.");
    expect(html).toContain('<a href="/blog/stripe-decline-codes">the full reference</a>');
  });

  it("renders a ::postlink on its own line as a paragraph holding the link", async () => {
    const { html } = await render("Intro.\n\n::postlink[dunning-email-sequence]\n\nAfter.");
    expect(html).toContain('<p><a href="/blog/dunning-email-sequence">How to Write a Dunning Email Sequence</a></p>');
    expect(html).toContain("<p>After.</p>");
  });

  it("shows an unresolved ::postlink as inline code, as Recova does, so an editor notices", async () => {
    const { html } = await render("Gone: ::postlink[deleted-post] and ::postlink[other|Other text].");
    expect(html).toContain("<code>::postlink[deleted-post]</code>");
    expect(html).toContain("<code>::postlink[other|Other text]</code>");
  });

  it("reads Recova's single-line :::diagram[slug] without swallowing the rest of the post", async () => {
    const { html } = await render("Before.\n\n:::diagram[funnel]\n\nAfter.\n\n## Next\n\nMore.");
    expect(html).toContain("<p>Before.</p>");
    expect(html).toContain("<p>After.</p>");
    expect(html).toContain('<h2 id="next">');
    // No diagram files exist yet (row F23), and Recova renders nothing for a missing file in production.
    expect(html).not.toContain("diagram");
  });

  it("draws a known diagram in Recova's figure, named for the reader", async () => {
    const { html } = await renderBlogMarkdown("Before.\n\n:::diagram[dispute-timeline]\n\nAfter.", {
      postLinks: PUBLISHED,
      diagrams: new Set(["dispute-timeline"]),
    });
    expect(html).toContain('<figure class="blog-diagram">');
    expect(html).toContain('src="/diagrams/dispute-timeline.svg" alt="Diagram: dispute timeline"');
  });

  it("never reads dollar amounts as math", async () => {
    const { html } = await render("A failed $49 charge retried on payday, and a $1,200 plan at $99/month.");
    expect(html).toContain("<p>A failed $49 charge retried on payday, and a $1,200 plan at $99/month.</p>");
    expect(html).not.toContain("katex");
  });

  it("never reads a colon in prose as a directive", async () => {
    const { html } = await render("Fails with decline_code:insufficient_funds at 9:00, Note:this, ratio 3:1.");
    expect(html).toContain("<p>Fails with decline_code:insufficient_funds at 9:00, Note:this, ratio 3:1.</p>");
  });

  it("shows an unknown one-line shortcode as inline code, as Recova does", async () => {
    const { html } = await render("::unknown[thing]");
    expect(html).toContain("<code>::unknown[thing]</code>");
  });

  it("renders an unknown block as a note callout, as Recova does, so nothing is dropped", async () => {
    const { html } = await render(":::sidebar\nKept content.\n:::");
    expect(html).toContain('class="blog-callout blog-callout-note"');
    expect(html).toContain("Kept content.");
  });

  it("renders Recova's callouts, pull quote and toggle with the classes the prose stylesheet styles", async () => {
    const { html } = await render(
      ":::tip\nRetry **after** payday.\n:::\n\n:::pullquote\nA *raw* quote.\n:::\n\n:::toggle[What is soft?]\nA later attempt may pass.\n:::",
    );
    expect(html).toContain(
      '<div class="blog-callout blog-callout-tip"><span class="blog-callout-icon" aria-hidden="true">\u{1F4A1}</span><div class="blog-callout-content"><p>Retry <strong>after</strong> payday.</p></div></div>',
    );
    expect(html).toContain('<blockquote class="blog-pullquote">A *raw* quote.</blockquote>');
    expect(html).toContain(
      '<details class="blog-toggle"><summary class="blog-toggle-header">What is soft?</summary><div class="blog-toggle-content"><p>A later attempt may pass.</p></div></details>',
    );
  });

  it("renders a :::faq block as Recova's definition list, and the FAQ JSON-LD reads the same pairs", async () => {
    const body = ":::faq\nQ: What is a decline code?\nA: The bank's reason.\nQ: Retry?\nA: Soft ones.\n:::";
    const { html } = await render(body);
    expect(html).toContain(
      '<div class="blog-faq" data-faq="true"><dl class="blog-faq-list"><div class="blog-faq-item"><dt class="blog-faq-question">What is a decline code?</dt><dd class="blog-faq-answer">The bank\'s reason.</dd></div>',
    );
    expect(extractFaqPairs(body)).toEqual([
      { question: "What is a decline code?", answer: "The bank's reason." },
      { question: "Retry?", answer: "Soft ones." },
    ]);
  });

  it("embeds ::youtube and links ::bookmark as the old renderer did", async () => {
    const { html } = await render("::youtube[dQw4w9WgXcQ]\n\n::bookmark[https://example.com/pricing]");
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(html).toContain(
      '<a href="https://example.com/pricing" target="_blank" rel="noopener noreferrer" class="blog-bookmark-link">example.com</a>',
    );
  });

  it("opens an outside link in a new tab and keeps www.foxhoundapp.com and relative links in the tab, as Recova's rule does", async () => {
    const { html } = await render(
      "[Stripe](https://stripe.com/docs) and [ours](https://www.foxhoundapp.com/pricing) and [old](https://www.recovamrr.com/x) and [rel](/pricing) and [bare](https://foxhoundapp.com/pricing).",
    );
    expect(html).toContain('<a href="https://stripe.com/docs" target="_blank" rel="noopener noreferrer">Stripe</a>');
    expect(html).toContain('<a href="https://www.foxhoundapp.com/pricing">ours</a>');
    expect(html).toContain('<a href="https://www.recovamrr.com/x">old</a>');
    expect(html).toContain('<a href="/pricing">rel</a>');
    // Recova's pattern is tested against the whole URL, so a bare-domain link
    // to the site itself opens a new tab. Kept as Recova and the old renderer
    // draw it; reported in the PR rather than changed here.
    expect(html).toContain('<a href="https://foxhoundapp.com/pricing" target="_blank" rel="noopener noreferrer">bare</a>');
  });

  it("passes Prelum's 44 hostile inputs through Foxhound's configured renderer with no violation", async () => {
    const result = await runConformance((source) => render(source));
    expect(result.inputs).toBe(44);
    expect(result.elements, "the scan read the output").toBeGreaterThan(0);
    // The one markup the pack adds to Prelum's allowlist on these inputs:
    // target and rel on an outside link (Recova's new-tab rule).
    const packOwn = (v: { tag: string; attribute?: string }) => v.tag === "a" && (v.attribute === "target" || v.attribute === "rel");
    expect(result.violations.filter((v) => !packOwn(v))).toEqual([]);
  });
});

function seed(db: Db, slug: string, title: string, published = true) {
  const now = new Date();
  return db.insert(blogPosts).values({
    id: slug,
    slug,
    title,
    excerpt: "x",
    body: "word",
    published,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
    author: "Foxhound",
    tags: [],
    featured: false,
  });
}

describe("renderPostBody resolves ::postlink against published D1 rows (J19)", () => {
  it("links a published post and leaves a draft as code", async () => {
    const { db } = createInMemoryDb();
    await seed(db, "live-post", "A Live Post");
    await seed(db, "draft-post", "A Draft", false);
    const { html } = await renderPostBody(db, "::postlink[live-post] and ::postlink[draft-post].");
    expect(html).toContain('<a href="/blog/live-post">A Live Post</a>');
    expect(html).toContain("<code>::postlink[draft-post]</code>");
  });
});

describe("excerpts render through Prelum (J19)", () => {
  it("returns plain excerpts exactly as written", async () => {
    const text = "Every failed charge comes back with a reason; a $49 retry at 9:00 is worth it.";
    expect(await excerptText(text, { postLinks: PUBLISHED })).toBe(text);
  });

  it("gives a ::postlink in an excerpt its post's title, not the raw shortcode", async () => {
    expect(await excerptText("Start with ::postlink[dunning-email-sequence].", { postLinks: PUBLISHED })).toBe(
      "Start with How to Write a Dunning Email Sequence.",
    );
  });

  it("reads markdown emphasis in an excerpt as its words", async () => {
    expect(await excerptText("Recover **more** revenue, *faster*.", { postLinks: PUBLISHED })).toBe("Recover more revenue, faster.");
  });

  it("renders every excerpt in a list, resolving postlinks against published rows", async () => {
    const { db } = createInMemoryDb();
    await seed(db, "live-post", "A Live Post");
    const out = await withRenderedExcerpts(db, [
      { slug: "a", excerpt: "See ::postlink[live-post]." },
      { slug: "b", excerpt: "Plain & simple." },
    ]);
    expect(out).toEqual([
      { slug: "a", excerpt: "See A Live Post." },
      { slug: "b", excerpt: "Plain & simple." },
    ]);
  });
});
