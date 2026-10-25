// J25 (row F23): the :::diagram[slug] directive renders Recova's hand-made
// SVG diagrams from /diagrams/<slug>.svg, as legacy lib/markdown.ts
// (blob 62a2e55c) renderDiagram does. Foxhound had dropped the directive and
// rendered nothing, so the eight posts that use it lost their diagram.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { scriptHash } from "@dustinedwards/site-runtime/csp";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { renderMarkdown } from "~/lib/blog/markdown.server";
import { DIAGRAM_STYLE_HASHES, INLINE_STYLE_HASHES } from "~/lib/http/inline-styles";

function emptyDb(): Db {
  return drizzle(async () => ({ rows: [] }), { schema }) as unknown as Db;
}

const ROOT = resolve(__dirname, "..");
const DIAGRAMS_DIR = resolve(ROOT, "public/diagrams");

function readDiagram(rel: string): string {
  return readFileSync(resolve(DIAGRAMS_DIR, rel), "utf8");
}

// The slugs the eight live posts use, read from production D1 on 2026-10-16
// (SELECT slug ... FROM blog_posts WHERE body LIKE '%:::diagram[%'), one each.
const POST_DIAGRAMS: Record<string, string> = {
  "dunning-email-sequence": "dunning-sequence-timeline",
  "involuntary-vs-voluntary-churn": "involuntary-vs-voluntary",
  "mrr-movement-explained": "mrr-waterfall",
  "net-revenue-retention-guide": "nrr-calculation",
  "stripe-decline-codes": "decline-code-taxonomy",
  "stripe-disputes-guide": "dispute-lifecycle",
  "stripe-failed-payment-recovery": "recovery-sequence",
  "stripe-smart-retries-vs-dunning": "recovery-vs-smart-retries",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe(":::diagram[slug] renders the SVG inline in a figure (legacy renderDiagram)", () => {
  it.each(Object.entries(POST_DIAGRAMS))("post %s: :::diagram[%s] renders its diagram", async (_post, slug) => {
    const svg = readDiagram(`${slug}.svg`);
    const label = slug.replace(/-/g, " ");
    const { html } = await renderMarkdown(emptyDb(), `Before.\n\n:::diagram[${slug}]\n\nAfter.`);
    expect(html).toBe(
      `<p>Before.</p>\n<figure class="blog-diagram" role="img" aria-label="Diagram: ${label}">${svg}</figure>\n<p>After.</p>\n`,
    );
  });

  it("is not mistaken for the opening of a fenced ::: block", async () => {
    const body = ":::diagram[dispute-lifecycle]\n\n:::tip\nCheck the deadline.\n:::";
    const { html } = await renderMarkdown(emptyDb(), body);
    expect(html).toContain('aria-label="Diagram: dispute lifecycle"');
    expect(html).toContain("blog-callout-tip");
    expect(html).toContain("Check the deadline.");
  });

  it("renders nothing for an unknown slug in production, as legacy did", async () => {
    vi.stubEnv("DEV", false);
    const { html } = await renderMarkdown(emptyDb(), "Before.\n\n:::diagram[funnel]\n\nAfter.");
    // Legacy stashed "" for a missing file, so the same blank line remains.
    expect(html).toBe("<p>Before.</p>\n\n<p>After.</p>\n");
  });

  it("shows the missing-file placeholder for an unknown slug in development, as legacy did", async () => {
    vi.stubEnv("DEV", true);
    const { html } = await renderMarkdown(emptyDb(), ":::diagram[funnel]");
    expect(html).toBe(
      '<figure class="blog-diagram blog-diagram--missing"><div class="blog-diagram-placeholder">Diagram not found: funnel.svg</div></figure>\n',
    );
  });
});

describe("the diagrams' own <style> elements pass the CSP", () => {
  // Inline in the page, each SVG's <style> is an inline style element, and
  // style-src has no 'unsafe-inline' for elements (J22). The browser hashes
  // the element's text as parsed, so character references are decoded first.
  function parsedStyleText(svg: string): string {
    const m = svg.match(/<style>([\s\S]*?)<\/style>/);
    if (!m) throw new Error("no <style> in diagram");
    return m[1]
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  it.each(Object.values(POST_DIAGRAMS))("%s: its <style> hash is trusted by the policy", async (slug) => {
    const hash = await scriptHash(parsedStyleText(readDiagram(`${slug}.svg`)));
    expect(INLINE_STYLE_HASHES).toContain(hash);
  });

  it("trusts no diagram hash that a served file does not produce", async () => {
    const served = readdirSync(DIAGRAMS_DIR).filter((f) => f.endsWith(".svg"));
    const computed = await Promise.all(served.map((f) => scriptHash(parsedStyleText(readDiagram(f)))));
    expect([...DIAGRAM_STYLE_HASHES].sort()).toEqual(computed.sort());
  });
});
