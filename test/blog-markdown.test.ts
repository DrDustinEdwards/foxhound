import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { extractFaqPairs } from "~/lib/blog/faq";
import { renderPostBody } from "~/lib/blog/render.server";

// Same empty-D1 stand-in as test/blog-queries.test.ts; renderPostBody only
// touches the db when a body contains ::postlink[...], so most cases below
// never exercise it.
function emptyDb(): Db {
  return drizzle(async () => ({ rows: [] }), { schema }) as unknown as Db;
}

describe("extractFaqPairs", () => {
  it("returns [] for a body with no :::faq block", async () => {
    expect(extractFaqPairs("# Just a heading\n\nSome text.")).toEqual([]);
  });

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

  it("flattens multiple :::faq blocks in one body", () => {
    const body = [
      ":::faq",
      "Q: First question?",
      "A: First answer.",
      ":::",
      "",
      "More prose.",
      "",
      ":::faq",
      "Q: Second question?",
      "A: Second answer.",
      ":::",
    ].join("\n");
    expect(extractFaqPairs(body)).toHaveLength(2);
  });
});

// These cases held the old marked renderer; since J19 they hold the Prelum
// renderer that replaced it to the same behaviour.
describe("renderPostBody", () => {
  it("renders plain markdown to HTML", async () => {
    const { html } = await renderPostBody(emptyDb(), "# Title\n\nSome **bold** text.");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("assigns ids to h2/h3 headings and returns a matching TOC", async () => {
    const { html, toc } = await renderPostBody(emptyDb(), "## First Section\n\nBody.\n\n### A Subsection\n\nMore.");
    expect(toc).toEqual([
      { level: 2, text: "First Section", id: "first-section" },
      { level: 3, text: "A Subsection", id: "a-subsection" },
    ]);
    expect(html).toContain('id="first-section"');
    expect(html).toContain('id="a-subsection"');
  });

  it("renders a :::tip callout", async () => {
    const { html } = await renderPostBody(emptyDb(), ":::tip\nDo this instead.\n:::");
    expect(html).toContain("blog-callout-tip");
    expect(html).toContain("Do this instead.");
  });

  it("drops :::diagram[slug] entirely rather than reading from disk", async () => {
    const { html } = await renderPostBody(emptyDb(), "Before.\n\n:::diagram[funnel]\n\nAfter.");
    expect(html).not.toContain("diagram");
    expect(html).toContain("Before.");
    expect(html).toContain("After.");
  });

  it("renders ::bookmark[url] as a plain link with no live OG fetch", async () => {
    const { html } = await renderPostBody(emptyDb(), "::bookmark[https://example.com/pricing]");
    expect(html).toContain('href="https://example.com/pricing"');
    expect(html).toContain("example.com");
    expect(html).toContain('target="_blank"');
  });

  it("renders ::youtube[id] as an embed iframe", async () => {
    const { html } = await renderPostBody(emptyDb(), "::youtube[dQw4w9WgXcQ]");
    expect(html).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  it("falls back to a visible <code> for an unresolved ::postlink", async () => {
    const { html } = await renderPostBody(emptyDb(), "See ::postlink[some-other-post] for more.");
    expect(html).toContain("<code>::postlink[some-other-post]</code>");
  });
});
