import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { BLOG_DIAGRAMS } from "~/lib/blog/diagrams";
import { renderMarkdown } from "~/lib/blog/markdown.server";

// An empty-D1 stand-in; renderMarkdown only
// touches the db when a body contains ::postlink[...], so most cases below
// never exercise it.
function emptyDb(): Db {
  return drizzle(async () => ({ rows: [] }), { schema }) as unknown as Db;
}

describe("renderMarkdown", () => {
  it("assigns ids to h2/h3 headings and returns a matching TOC", async () => {
    const { html, toc } = await renderMarkdown(
      emptyDb(),
      "## First Section\n\nBody.\n\n### A Subsection\n\nMore.",
    );
    expect(toc).toEqual([
      { level: 2, text: "First Section", id: "first-section" },
      { level: 3, text: "A Subsection", id: "a-subsection" },
    ]);
    expect(html).toContain('id="first-section"');
    expect(html).toContain('id="a-subsection"');
  });

  function diagram(slug: string): string {
    return `:::figure{src="/diagrams/${slug}-light-1x1.svg" dark="/diagrams/${slug}-dark-1x1.svg" alt="Diagram"}\n:::`;
  }

  it("inlines each diagram as one figure, with its title and description", async () => {
    for (const slug of Object.keys(BLOG_DIAGRAMS)) {
      const { html } = await renderMarkdown(emptyDb(), diagram(slug));
      expect(html, slug).toContain(
        `<figure class="blog-diagram" role="img" aria-labelledby="${slug}-title" aria-describedby="${slug}-desc">`,
      );
      expect(html, slug).toContain(`<title id="${slug}-title">`);
      expect(html, slug).toContain(`<desc id="${slug}-desc">`);
      expect(html, slug).toContain("<svg ");
      expect(html, slug).not.toContain("<img");
      expect(html, slug).not.toContain("<style");
      expect(html, slug).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
    const recovery = await renderMarkdown(emptyDb(), diagram("recovery-sequence"));
    expect(recovery.html).toContain(">CANCELED<");
    expect(recovery.html).not.toContain("CANCELLED");
    expect(recovery.html).toContain('width="680"');
    expect(recovery.html).toContain('height="820"');
    const withdrawn = await renderMarkdown(emptyDb(), diagram("nrr-calculation"));
    expect(withdrawn.html).not.toContain("blog-diagram");
    expect(withdrawn.html).not.toContain("<img");
    await expect(renderMarkdown(emptyDb(), diagram("not-a-diagram"))).rejects.toThrow(
      /not a diagram this site draws/,
    );
    await expect(renderMarkdown(emptyDb(), "![x](https://example.com/a.png)")).rejects.toThrow(
      /not an image this site serves/,
    );
  });

  it("falls back to a visible <code> for an unresolved ::postlink, also at the start of a line and inside bold", async () => {
    const { html } = await renderMarkdown(
      emptyDb(),
      "See ::postlink[some-other-post] for more.\n\n::postlink[a-post|Its name] starts this line.\n\n**::postlink[b-post]**",
    );
    expect(html).toBe(
      "<p>See <code>::postlink[some-other-post]</code> for more.</p>\n" +
        "<p><code>::postlink[a-post|Its name]</code> starts this line.</p>\n" +
        "<p><strong><code>::postlink[b-post]</code></strong></p>",
    );
  });

  it("keeps legacy's heading ids", async () => {
    const { html } = await renderMarkdown(
      emptyDb(),
      "## What does call_issuer mean?\n\n[Stripe](https://stripe.com).",
    );
    expect(html).toContain('<h2 id="what-does-callissuer-mean">');
    expect(html).toContain('<a href="https://stripe.com">Stripe</a>');
  });

  it("links a post named in a :::faq answer, and gives the JSON-LD its words", async () => {
    const db = drizzle(async () => ({ rows: [["stripe-recovery", "Stripe recovery"]] }), {
      schema,
    }) as unknown as Db;
    const { html, faq } = await renderMarkdown(
      db,
      ":::faq\nQ: Where next?\nA: The ::postlink[stripe-recovery|full recovery system] works upstream.\n:::",
    );
    expect(html).toContain(
      '<dd>The <a href="/blog/stripe-recovery">full recovery system</a> works upstream.</dd>',
    );
    expect(faq).toEqual([
      { question: "Where next?", answer: "The full recovery system works upstream." },
    ]);
  });
});
