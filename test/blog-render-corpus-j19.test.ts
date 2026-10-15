import { readdirSync, readFileSync } from "node:fs";

import { parseFragment } from "parse5";
import { describe, expect, it } from "vitest";

import { renderBlogMarkdown } from "~/lib/blog/render.server";

import { renderMarkdownBefore } from "./support/render-before";

// J19 (job_deffd581af37), DO step 3: "the whole post corpus is compared before
// and after, as Prelum's CHANGELOG asks of a site switching over" (Prelum 0.2.0:
// "a site switching over should still compare its whole corpus").
//
// Every body is rendered twice: through the renderer Foxhound used until J19
// (test/support/render-before.ts, a frozen copy) and through Prelum with
// Foxhound's pack. Both outputs are read with parse5 into one canonical form.
// Prelum's own additions are named rules below, each counted, and removed from
// the new side only; whatever differs after that is a change a reader would see,
// and is pinned in EXPECTED_DIFFERENCES with its reason.
//
// The corpus is test/fixtures/blog-corpus/*.md. The production corpus lives in
// D1; BLOG_CORPUS=<export.json> runs the same comparison over it (see the
// fixtures' README for the read-only export command).

interface Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
}

type Rule = "heading-anchor" | "table-scroll" | "image-link" | "image-attrs" | "extra-heading-id" | "code-highlight";

const BLOCKS = new Set([
  "p", "div", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "hr", "figure", "details", "summary", "dl", "dt", "dd",
]);

function attr(node: Node, name: string): string | undefined {
  return node.attrs?.find((a) => a.name === name)?.value;
}

function hasClass(node: Node, cls: string): boolean {
  return (attr(node, "class") ?? "").split(/\s+/).includes(cls);
}

/** One canonical string for a fragment. `after` turns on Prelum's rules. */
function canonical(html: string, side: "before" | "after", counts: Map<Rule, number>): string {
  const bump = (r: Rule) => counts.set(r, (counts.get(r) ?? 0) + 1);

  function walk(node: Node, inCode: boolean): string {
    if (node.nodeName === "#text") return (node.value ?? "").replace(/\s+/g, " ");
    if (node.nodeName === "#comment") return "";
    const tag = node.tagName ?? node.nodeName;
    const kids = (node.childNodes ?? []).map((c) => walk(c, inCode || tag === "code"));
    const inner = kids.join("");

    if (side === "after") {
      if (tag === "a" && hasClass(node, "heading-anchor")) {
        bump("heading-anchor");
        return "";
      }
      if (tag === "div" && hasClass(node, "table-scroll")) {
        bump("table-scroll");
        return inner;
      }
      if (tag === "a" && hasClass(node, "image-link")) {
        bump("image-link");
        return inner;
      }
    }
    // highlight.js wraps code in spans; Prelum without a highlighter does not.
    if (inCode && tag === "span") {
      if (side === "before") bump("code-highlight");
      return inner;
    }

    let attrs = [...(node.attrs ?? [])];
    if (tag === "pre" || tag === "code") attrs = attrs.filter((a) => a.name !== "class");
    if (side === "after" && tag === "img") {
      const dropped = attrs.filter((a) => ["loading", "decoding", "fetchpriority", "width", "height"].includes(a.name));
      if (dropped.length > 0) bump("image-attrs");
      attrs = attrs.filter((a) => !dropped.includes(a));
    }
    if (side === "after" && ["h1", "h4", "h5", "h6"].includes(tag) && attrs.some((a) => a.name === "id")) {
      bump("extra-heading-id");
      attrs = attrs.filter((a) => a.name !== "id");
    }
    const attrText = attrs
      .map((a) => `${a.name}="${a.value}"`)
      .sort()
      .join(" ");
    const open = attrText ? `<${tag} ${attrText}>` : `<${tag}>`;
    // Whitespace at the edge of a block, or of code ("x\n" against "x"), draws nothing.
    const body = BLOCKS.has(tag) || tag === "code" ? inner.trim() : inner;
    return `${open}${body}</${tag}>`;
  }

  const root = parseFragment(html) as unknown as Node;
  return (root.childNodes ?? [])
    .map((c) => walk(c, false))
    .join("")
    .replace(/>\s+</g, "><")
    // Nor does whitespace just before a block starts (a nested list in an item).
    .replace(new RegExp(`\\s+(<(?:${[...BLOCKS].join("|")})[ >])`, "g"), "$1")
    .trim();
}

interface CorpusPost {
  slug: string;
  body: string;
}

function fixtureCorpus(): { posts: CorpusPost[]; published: Map<string, { slug: string; title: string }> } {
  const dir = new URL("./fixtures/blog-corpus/", import.meta.url);
  const titles = JSON.parse(readFileSync(new URL("published.json", dir), "utf8")) as Record<string, string>;
  const posts = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => ({ slug: f.replace(/\.md$/, ""), body: readFileSync(new URL(f, dir), "utf8") }));
  return { posts, published: new Map(Object.entries(titles).map(([slug, title]) => [slug, { slug, title }])) };
}

/** A wrangler d1 --json export of blog_posts (slug, title, body, published). */
function exportedCorpus(file: string): { posts: CorpusPost[]; published: Map<string, { slug: string; title: string }> } {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const rows = (Array.isArray(parsed) ? (parsed[0] as { results: unknown[] }).results : (parsed as { results: unknown[] }).results) as Array<{
    slug: string;
    title: string;
    body: string;
    published: number | boolean;
  }>;
  const published = new Map(rows.filter((r) => r.published === 1 || r.published === true).map((r) => [r.slug, { slug: r.slug, title: r.title }]));
  return { posts: rows.map((r) => ({ slug: r.slug, body: r.body })), published };
}

/** The first place two canonical strings part, with some context. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `before: ...${a.slice(Math.max(0, i - 60), i + 80)}...\n after: ...${b.slice(Math.max(0, i - 60), i + 80)}...`;
}

async function compare(posts: CorpusPost[], published: Map<string, { slug: string; title: string }>) {
  const counts = new Map<Rule, number>();
  const differences: Record<string, string> = {};
  for (const post of posts) {
    const before = await renderMarkdownBefore(async (slug) => published.get(slug) ?? null, post.body);
    const after = await renderBlogMarkdown(post.body, { postLinks: published });
    const a = canonical(before.html, "before", counts);
    const b = canonical(after.html, "after", counts);
    if (a !== b) differences[post.slug] = firstDifference(a, b);
    expect(after.toc, `${post.slug}: the table of contents is unchanged`).toEqual(
      before.toc.map((t) => ({ ...t, text: t.text.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"') })),
    );
  }
  return { counts, differences };
}

// What a reader sees differently after the switch, per fixture, after Prelum's
// named additions are set aside. Each is reported in the PR.
const EXPECTED_DIFFERENCES: Record<string, string> = {
  // Prelum drops raw HTML from the source by construction; the old renderer
  // kept an allowlisted <br> and <strong>. The words stay, the tags go.
  "images-and-html": "raw HTML tags dropped",
  // An unknown one-line shortcode is inline code in both, but Prelum's sits in
  // a paragraph where the old renderer's stood alone.
  shortcodes: "unknown ::shortcode code sits in a <p>",
};

describe("whole-corpus comparison, old renderer against Prelum (J19)", () => {
  it("renders every fixture post the same once Prelum's own additions are set aside", async () => {
    const { posts, published } = fixtureCorpus();
    expect(posts.length, "the corpus has posts").toBeGreaterThanOrEqual(8);
    const { counts, differences } = await compare(posts, published);
    console.log("J19 corpus: rule counts", Object.fromEntries(counts), "differences", differences);
    expect(Object.keys(differences).sort()).toEqual(Object.keys(EXPECTED_DIFFERENCES).sort());
    // Prelum's additions were actually seen, so the rules are not vacuous.
    expect(counts.get("heading-anchor") ?? 0).toBeGreaterThan(0);
    expect(counts.get("table-scroll") ?? 0).toBeGreaterThan(0);
  });

  it.runIf(Boolean(process.env.BLOG_CORPUS))("renders the exported production corpus the same", async () => {
    const { posts, published } = exportedCorpus(process.env.BLOG_CORPUS ?? "");
    const { counts, differences } = await compare(posts, published);
    console.log("J19 production corpus:", posts.length, "posts; rule counts", Object.fromEntries(counts));
    for (const [slug, diff] of Object.entries(differences)) console.log(`DIFFERS ${slug}\n${diff}\n`);
    expect(Object.keys(differences)).toEqual([]);
  });
});
