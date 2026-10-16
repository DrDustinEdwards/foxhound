// J25 (row F23): the :::diagram[slug] directive renders Recova's hand-made
// SVG diagrams from /diagrams/<slug>.svg, as legacy lib/markdown.ts
// (blob 62a2e55c) renderDiagram does. Foxhound had dropped the directive and
// rendered nothing, so the eight posts that use it lost their diagram.
import { createHash } from "node:crypto";
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

// Git's blob id for a file's bytes: proves each file is byte-identical to the
// legacy blob at the sha Capsid's repo read reported for public/diagrams/.
function gitBlobSha(rel: string): string {
  const bytes = readFileSync(resolve(DIAGRAMS_DIR, rel));
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// Recova public/diagrams/ at HEAD (DrDustinEdwards/recova, main), as listed
// by Capsid's repo tree on 2026-10-16: eight served diagrams and their eight
// readable sources, sixteen files.
const LEGACY_BLOBS: Record<string, string> = {
  "decline-code-taxonomy.svg": "4ced835a0cc4f6ddc3a67300495827a0fad63524",
  "dispute-lifecycle.svg": "4809dc04c305383f1fa86fe4187111cba59b40fa",
  "dunning-sequence-timeline.svg": "b02843b9211699b94cd88754b51185f450cbd627",
  "involuntary-vs-voluntary.svg": "5c875b40706e2637919f3bb1e05d6c76cb802ff6",
  "mrr-waterfall.svg": "ebb347c880a68cfc088ec4f433c03dd35ed418ca",
  "nrr-calculation.svg": "fc47fa7ed19280b41e8cd9cdc7c1f20e27160774",
  "recovery-sequence.svg": "c6d98a94c2dd945c67a06b14cb5d4f2a00731abb",
  "recovery-vs-smart-retries.svg": "7677ba704518b4f4af9b887abfe749b357418e9c",
  "source/decline-code-taxonomy.svg": "bc9f30b0a87e6e6fb7dd1171851706e99648c882",
  "source/dispute-lifecycle.svg": "3668e6c865bf66083c1bdc8288ee4bf7811268b5",
  "source/dunning-sequence-timeline.svg": "d9481cad17da06cb42c56ac545e7c8fe272c6db4",
  "source/involuntary-vs-voluntary.svg": "4134ff5be28bd165bc23d01c3a40bb41b2933c91",
  "source/mrr-waterfall.svg": "c91669d484cac716b5ed050497d52b29e60cfd4e",
  "source/nrr-calculation.svg": "982a71e429d03aaae8d91c1fb57e8d4b0cfb13da",
  "source/recovery-sequence.svg": "e05af1e0f62887afe6252834be6117d9ece1c00d",
  "source/recovery-vs-smart-retries.svg": "0bcd6d83fddd9b345c110494af6985cd584d1567",
};

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

describe("public/diagrams is Recova's set, byte for byte", () => {
  it("holds exactly the sixteen legacy files", () => {
    const served = readdirSync(DIAGRAMS_DIR).filter((f) => f.endsWith(".svg"));
    const sources = readdirSync(resolve(DIAGRAMS_DIR, "source")).map((f) => `source/${f}`);
    expect([...served, ...sources].sort()).toEqual(Object.keys(LEGACY_BLOBS).sort());
  });

  it.each(Object.entries(LEGACY_BLOBS))("%s has the legacy blob sha", (rel, sha) => {
    expect(gitBlobSha(rel)).toBe(sha);
  });
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

  it("never passes the trusted SVG through the author-body sanitizer", async () => {
    const { html } = await renderMarkdown(emptyDb(), ":::diagram[recovery-sequence]");
    expect(html).toContain("<style>");
    expect(html).toContain('marker-end="url(#arrow-rs)"');
    expect(html).toContain("<title>Stripe failed-payment recovery sequence by decline category</title>");
  });

  it("is not mistaken for the opening of a fenced ::: block", async () => {
    const body = ":::diagram[dispute-lifecycle]\n\n:::tip\nCheck the deadline.\n:::";
    const { html } = await renderMarkdown(emptyDb(), body);
    expect(html).toContain('aria-label="Diagram: dispute lifecycle"');
    expect(html).toContain("blog-callout-tip");
    expect(html).toContain("Check the deadline.");
  });

  it("has one meaning only: a file under /diagrams, never Mermaid or inline source", async () => {
    const body = ":::diagram\ngraph TD; A-->B\n:::";
    const { html } = await renderMarkdown(emptyDb(), body);
    expect(html).not.toContain("blog-diagram");
    expect(html).not.toContain("<svg");
  });

  it("does not read a source/ file or any path outside /diagrams", async () => {
    for (const slug of ["source", "../root", "source/recovery-sequence"]) {
      const { html } = await renderMarkdown(emptyDb(), `:::diagram[${slug}]`);
      expect(html).not.toContain("<svg");
    }
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

describe("the figure keeps legacy's layout rules", () => {
  it("app.css carries .blog-diagram, its svg and the missing variant", () => {
    const css = readFileSync(resolve(ROOT, "app/app.css"), "utf8");
    expect(css).toMatch(/\.blog-diagram \{\s*margin: 2rem 0;\s*overflow: visible;\s*\}/);
    expect(css).toMatch(/\.blog-diagram svg \{\s*width: 100%;\s*height: auto;\s*display: block;\s*\}/);
    expect(css).toMatch(/\.blog-diagram--missing \{/);
  });
});
