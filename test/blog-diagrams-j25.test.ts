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

// Recova public/diagrams/ at HEAD (DrDustinEdwards/recova, main), as listed
// by Capsid's repo tree on 2026-10-16: eight served diagrams and their eight
// readable sources, sixteen files. Commit 54efd0d ported them byte for byte
// (each file's git blob sha equal to legacy's, e.g. recovery-sequence.svg
// c6d98a94). Q11 then moved their amber accents to teal, so what is pinned
// here is each legacy file's SHA-256 with every six-digit colour masked:
// apart from colour literals, every byte is still Recova's.
const LEGACY_SHAPE: Record<string, string> = {
  "decline-code-taxonomy.svg": "486fa35106d9390a14710c3f4de57c384caf13ca10ac5db39833e740d0714cfe",
  "dispute-lifecycle.svg": "c09b79eb7662dba755714d12fc35800431b1a78685c716b6fa64fa03c36ae490",
  "dunning-sequence-timeline.svg": "d133515243f0aedc89b2db449d588c246d222b7ee23ee669472db7db0569b92c",
  "involuntary-vs-voluntary.svg": "d60bcfc475ba01f58257baff6f4d134d65f9ac65f3edc446e717af4c6ef6f67c",
  "mrr-waterfall.svg": "943d9877eaf8ab429b2d15dd392e68eafb4d35a0562d85ab8526fc9a5978eb0f",
  "nrr-calculation.svg": "1c6b345ef5d060d8154149522a247410c09d7c9f82689bd3cf74cec599fcc6bb",
  "recovery-sequence.svg": "46b9e2354ad6ebddb5b5d0fd7d62021a59d1b73f5df15d586a2a4038f252f540",
  "recovery-vs-smart-retries.svg": "1d71475f4640c03a14c2db4839ebba77b5e03cdf4ff4bc6c4d0fffc4e9bfadae",
  "source/decline-code-taxonomy.svg": "3c656da2969fface844a9857cecb29bf61342eeacae47737c5c569240753928f",
  "source/dispute-lifecycle.svg": "e56796acec25fcc40d5dd4779d2fff19748b6233d6267acb4d25806f7a5c5793",
  "source/dunning-sequence-timeline.svg": "cf74809d04f5ee37c7239b2d43a9a7f1be4e235165cf5de6ec8a48938fd308fa",
  "source/involuntary-vs-voluntary.svg": "68dbc0f698a78cc559f4e666cd81c787bf153dfdff7e21ceff526bda0926b5c7",
  "source/mrr-waterfall.svg": "578b581068c81bb30bdf775332c3d85c351d15ca7ad9ece15cb3d48cce513aa7",
  "source/nrr-calculation.svg": "d95390efbd76359bb6d17d9677cca0eea60085c30cffeea2ba035c3f9ac8d7a1",
  "source/recovery-sequence.svg": "1cb82e87463bd09d81ddc223a11a558753ccfc5348f59c29a26d8b3aea5d2a6c",
  "source/recovery-vs-smart-retries.svg": "48790768e234db6513c25e4865cc3ec57f1ad762f47a5017ce5d16b61ddbdbe1",
};

function maskedSha(rel: string): string {
  const text = readDiagram(rel).replace(/#[0-9a-fA-F]{6}/g, "#xxxxxx");
  return createHash("sha256").update(text).digest("hex");
}

// Q11 (APPROVED-DIFFERENCES.md, Dustin "yes", 2026-10-14): no page carries
// an amber accent. Each amber literal takes the teal of the token that held
// it in the Q11 change (PR #51): --amber-bg to --brand-bg, --amber-dark to
// --brand-dark, --amber-text to --brand-text, --amber-border-interactive to
// --brand-border-interactive, and the dark --amber-ui to --brand-ui for lines
// and arrowheads. Recova's light accent tint #faeeda held no token; it is the
// accent background, so it takes --brand-bg.
const TEAL_RULES: Record<string, { light: string; dark: string }> = {
  "node-accent": { light: "{ fill: #e8f5f5; stroke: #01585c; }", dark: "{ fill: #1a2d2e; stroke: #2d7c80; }" },
  "event-retry": { light: "{ fill: #e8f5f5; stroke: #01585c; }", dark: "{ fill: #1a2d2e; stroke: #2d7c80; }" },
  "bar-net": { light: "{ fill: #e8f5f5; stroke: #01585c; }", dark: "{ fill: #1a2d2e; stroke: #2d7c80; }" },
  "label-accent": {
    light: "{ fill: #01585c; font-family: system-ui, sans-serif; font-size: 13px; font-weight: 600; }",
    dark: "{ fill: #97c8cb; }",
  },
  "rate-num": {
    light: "{ fill: #01585c; font-family: system-ui, sans-serif; font-size: 22px; font-weight: 700; }",
    dark: "{ fill: #97c8cb; }",
  },
  "connector-accent": { light: "{ stroke: #01585c; stroke-width: 1.5; fill: none; }", dark: "{ stroke: #249398; }" },
  "arrow-head-accent": { light: "{ fill: #01585c; }", dark: "{ fill: #249398; }" },
};

const AMBER = /#(?:f0b429|ffd166|d4941a|b87c10|9e6a0a|8a5c06|f5d98a|b2861f|826217|3d3010|1e1a0a|1f1a0a|fff5d6|faecbf|b5820d|fdf3d8|faeeda)\b/i;

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

describe("public/diagrams is Recova's set, recoloured teal by Q11 only", () => {
  it("holds exactly the sixteen legacy files", () => {
    const served = readdirSync(DIAGRAMS_DIR).filter((f) => f.endsWith(".svg"));
    const sources = readdirSync(resolve(DIAGRAMS_DIR, "source")).map((f) => `source/${f}`);
    expect([...served, ...sources].sort()).toEqual(Object.keys(LEGACY_SHAPE).sort());
  });

  it.each(Object.entries(LEGACY_SHAPE))("%s is Recova's file in every byte but its colours", (rel, sha) => {
    expect(maskedSha(rel)).toBe(sha);
  });

  it.each(Object.keys(LEGACY_SHAPE))("%s carries no amber, and each accent rule has Q11's teal", (rel) => {
    const svg = readDiagram(rel).replace(/&quot;/g, '"');
    expect(svg).not.toMatch(AMBER);
    let accents = 0;
    for (const line of svg.split("\n")) {
      const m = line.match(/\.([a-z-]+)\s+(\{[^}]*\})/);
      if (!m || !(m[1] in TEAL_RULES)) continue;
      accents++;
      const theme = line.includes('[data-theme="dark"]') ? "dark" : "light";
      expect(`${m[1]} ${m[2]}`).toBe(`${m[1]} ${TEAL_RULES[m[1]][theme]}`);
    }
    if (!/involuntary-vs-voluntary/.test(rel)) expect(accents).toBeGreaterThan(0);
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
