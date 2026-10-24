import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { extractFaqPairs, renderMarkdown } from "~/lib/blog/markdown.server";

// An empty-D1 stand-in; renderMarkdown only
// touches the db when a body contains ::postlink[...], so most cases below
// never exercise it.
function emptyDb(): Db {
  return drizzle(async () => ({ rows: [] }), { schema }) as unknown as Db;
}

describe("extractFaqPairs", () => {

  it("parses Q:/A: pairs out of a :::faq block", () => {
    const body = [
      "Intro paragraph.",
      "",
      ":::faq",
      "Q: What is a decline code?",
      "A: A reason Stripe gives for a failed charge.",
      "Q: Can it be retried?",
      "A: Yes, for soft declines.",
      ":::",
      "",
      "Outro.",
    ].join("\n");
    expect(extractFaqPairs(body)).toEqual([
      { question: "What is a decline code?", answer: "A reason Stripe gives for a failed charge." },
      { question: "Can it be retried?", answer: "Yes, for soft declines." },
    ]);
  });
});

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

  it("renders ::bookmark[url] as a plain link with no live OG fetch", async () => {
    const { html } = await renderMarkdown(emptyDb(), "::bookmark[https://example.com/pricing]");
    expect(html).toContain('href="https://example.com/pricing"');
    expect(html).toContain("example.com");
    expect(html).toContain('target="_blank"');
  });

  it("renders ::youtube[id] as an embed iframe", async () => {
    const { html } = await renderMarkdown(emptyDb(), "::youtube[dQw4w9WgXcQ]");
    expect(html).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  it("falls back to a visible <code> for an unresolved ::postlink", async () => {
    const { html } = await renderMarkdown(emptyDb(), "See ::postlink[some-other-post] for more.");
    expect(html).toContain("<code>::postlink[some-other-post]</code>");
  });
});
