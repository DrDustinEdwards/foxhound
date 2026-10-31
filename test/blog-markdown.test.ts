import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { renderMarkdown } from "~/lib/blog/markdown.server";

// An empty-D1 stand-in; renderMarkdown only
// touches the db when a body contains ::postlink[...], so most cases below
// never exercise it.
function emptyDb(): Db {
  return drizzle(async () => ({ rows: [] }), { schema }) as unknown as Db;
}

describe("renderMarkdown", () => {

  it("assigns ids to h2/h3 headings and returns a matching TOC", async () => {
    const { html, toc } = await renderMarkdown(emptyDb(), "## First Section\n\nBody.\n\n### A Subsection\n\nMore.");
    expect(toc).toEqual([
      { level: 2, text: "First Section", id: "first-section" },
      { level: 3, text: "A Subsection", id: "a-subsection" },
    ]);
    expect(html).toContain('id="first-section"');
    expect(html).toContain('id="a-subsection"');
  });

  it("renders a diagram figure as its light and dark drawings, sized from the file name", async () => {
    const { html } = await renderMarkdown(
      emptyDb(),
      ':::figure{src="/diagrams/mrr-waterfall-light-680x380.svg" dark="/diagrams/mrr-waterfall-dark-680x380.svg" alt="Two waterfalls"}\n:::',
    );
    expect(html).toContain('<img src="/diagrams/mrr-waterfall-light-680x380.svg" alt="Two waterfalls" class="figure-light" width="680" height="380"');
    expect(html).toContain('<img src="/diagrams/mrr-waterfall-dark-680x380.svg" alt="Two waterfalls" class="figure-dark" width="680" height="380"');
    await expect(renderMarkdown(emptyDb(), "![x](https://example.com/a.png)")).rejects.toThrow(/not an image this site serves/);
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
    const { html } = await renderMarkdown(emptyDb(), "## What does call_issuer mean?\n\n[Stripe](https://stripe.com).");
    expect(html).toContain('<h2 id="what-does-callissuer-mean">');
    expect(html).toContain('<a href="https://stripe.com">Stripe</a>');
  });

  it("links a post named in a :::faq answer, and gives the JSON-LD its words", async () => {
    const db = drizzle(async () => ({ rows: [["stripe-recovery", "Stripe recovery"]] }), { schema }) as unknown as Db;
    const { html, faq } = await renderMarkdown(db, ":::faq\nQ: Where next?\nA: The ::postlink[stripe-recovery|full recovery system] works upstream.\n:::");
    expect(html).toContain('<dd>The <a href="/blog/stripe-recovery">full recovery system</a> works upstream.</dd>');
    expect(faq).toEqual([{ question: "Where next?", answer: "The full recovery system works upstream." }]);
  });
});
