import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { blogPosts } from "~/db";
import type { Db } from "~/db";
import type { BlogPostSummary } from "~/lib/blog/queries.server";
import { SECTIONS } from "~/lib/blog/sections";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J19 (job_deffd581af37), rows M11 (/blog) and M14 (/blog/tag/:tag). Recova's
// spec, read whole: app/(marketing)/blog/page.tsx (blob d2d4dbfd),
// BlogHeaderIntro.tsx (a8ba9e72), BlogPostCard.tsx (48ba6d39), lib/blog.ts
// (55a92d1a) and tag/[tag]/page.tsx (3f6aa696).
//
// Recova is the spec for content, layout and features; the parts are
// Capsomer's (Q12), the colour teal (Q11), the text on the five sizes
// (RULES.md 5.2). The defects not copied: a section over a tag with no posts,
// Recova's arbitrary text-[X] sizes, and an unknown tag served as a page.
// These read the RENDERED page, so a class on a helper that never reaches a
// reader cannot pass.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/cloudflare-context", () => ({
  cloudflareContext: Symbol("cloudflare") as unknown,
}));

const index = await import("~/routes/blog/index");
const tag = await import("~/routes/blog/tag");

const context = { get: () => ({ env: { DB: {}, BETTER_AUTH_URL: "https://example.com" } }) };

function seed(
  db: Db,
  slug: string,
  opts: { tags?: string[]; published?: boolean; featured?: boolean; daysAgo?: number } = {},
) {
  const at = new Date(Date.UTC(2026, 8, 30) - (opts.daysAgo ?? 0) * 86_400_000);
  return db.insert(blogPosts).values({
    id: slug,
    slug,
    title: `Title of ${slug}`,
    excerpt: `Excerpt of ${slug}.`,
    body: "word ".repeat(400),
    published: opts.published ?? true,
    publishedAt: at,
    createdAt: at,
    updatedAt: at,
    author: "Foxhound",
    tags: opts.tags ?? [],
    featured: opts.featured ?? false,
    readingMinutes: 2,
  });
}

function summary(slug: string, tags: string[] = ["payment-recovery"], extra: Partial<BlogPostSummary> = {}): BlogPostSummary {
  return {
    id: slug,
    slug,
    title: `Title of ${slug}`,
    excerpt: `Excerpt of ${slug}.`,
    coverImageUrl: null,
    coverImageAlt: null,
    publishedAt: new Date(Date.UTC(2026, 8, 30)),
    updatedAt: null,
    author: "Foxhound",
    tags,
    featured: false,
    readingTimeMinutes: 4,
    ...extra,
  };
}

function renderPage(Page: (props: never) => unknown, loaderData: unknown, path: string): string {
  const page = createElement(Page as never, { loaderData } as never);
  const router = createMemoryRouter([{ path: "*", element: page }], { initialEntries: [path] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

const openTag = (el: string) => el.slice(0, el.indexOf(">") + 1);
const classOf = (el: string) => /class="([^"]*)"/.exec(openTag(el))?.[1] ?? "";
const href = (el: string) => /href="([^"]+)"/.exec(el)?.[1];
const links = (html: string) => [...html.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const cards = (html: string) => links(html).filter((a) => classOf(a).split(/\s+/).includes("cap-panel"));
const beforeScript = (html: string) => html.slice(0, html.indexOf("<script"));

const FIVE_SIZES = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
// Tailwind text-* utilities that are colours or alignment, not sizes.
const NOT_A_SIZE = /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|accent-hover|brand-text|left|center|right)$/;

function sizesIn(html: string): string[] {
  const sizes: string[] = [];
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) {
      const base = c.replace(/^(?:[a-z0-9-]+:)+/, "");
      if (base.startsWith("text-") && !NOT_A_SIZE.test(base)) sizes.push(base);
    }
  }
  return sizes;
}

function expectCapsomerLook(html: string) {
  const body = beforeScript(html);
  // The teal family with Foxhound's neutrals, as the /docs and /products pages.
  expect(body).toMatch(/class="fh-cap[" ][^>]*data-family="teal"/);
  expect(body, "no amber anywhere on the page").not.toMatch(/amber/i);
  expect(body, "no arbitrary text size").not.toMatch(/text-\[/);
  const sizes = sizesIn(body);
  expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(0);
  for (const s of sizes) expect(FIVE_SIZES.has(s), `${s} is one of the five`).toBe(true);
  // Every post card is Capsomer's panel as the whole-card link, with no
  // Foxhound class on the panel ("group" only drives a hover nudge).
  const cs = cards(body);
  expect(cs.length, "the page renders post cards").toBeGreaterThan(0);
  for (const c of cs) {
    expect(classOf(c).split(/\s+/).filter((x) => x !== "cap-panel" && x !== "group")).toEqual([]);
    expect(c).toContain('class="cap-panel-body"');
  }
}

const INDEX_DATA = {
  siteUrl: "https://example.com",
  featured: summary("featured-post", ["disputes"], { featured: true }),
  sections: SECTIONS.slice(0, 2).map((section) => ({
    section,
    posts: section.slugs.slice(0, 2).map((s) => summary(s, [section.tagHref.split("/").pop() ?? ""])),
  })),
  latest: [summary("latest-a"), summary("latest-b", [])],
};

describe("/blog index (J19, row M11)", () => {
  const html = renderPage(index.default as never, INDEX_DATA, "/blog");

  it("is built from Capsomer's parts, teal, on the five text sizes", () => {
    expectCapsomerLook(html);
  });

  it("keeps Recova's header: the Posts eyebrow, the Blog title, its line, and All articles to the archive", () => {
    const body = beforeScript(html);
    expect(body).toMatch(/>Posts<\/div>/);
    expect(body).toMatch(/<h1[^>]*>Blog<\/h1>/);
    expect(body).toContain("Guides on Stripe payment recovery, dispute handling, and subscription intelligence.");
    const all = links(body).find((a) => href(a) === "/blog/archive");
    expect(all, "the All articles link").toBeDefined();
    expect(all).toContain("All articles");
  });

  it("draws the featured post's tag as Capsomer's outline pill and its CTA as Capsomer's primary button", () => {
    const body = beforeScript(html);
    const pill = links(body).find((a) => href(a) === "/blog/tag/disputes");
    expect(pill, "the featured tag links to its tag page").toBeDefined();
    expect(classOf(pill!)).toBe("cap-pill");
    expect(openTag(pill!)).toContain('data-variant="outline"');
    const cta = links(body).find((a) => a.includes("Read the guide"));
    expect(cta, "Read the guide").toBeDefined();
    // "group" carries no style; it drives the arrow's hover nudge.
    expect(classOf(cta!)).toBe("cap-btn group");
    expect(openTag(cta!)).toContain('data-variant="primary"');
    expect(href(cta!)).toBe("/blog/featured-post");
  });

  it("keeps Recova's sections in order, each with its label, description and See all to its tag page", () => {
    const body = beforeScript(html);
    let from = 0;
    for (const { section } of INDEX_DATA.sections) {
      const at = body.indexOf(section.label, from);
      expect(at, `${section.label} renders after the one before`).toBeGreaterThan(from);
      expect(body.indexOf(section.description, at)).toBeGreaterThan(at);
      const seeAll = links(body.slice(at)).find((a) => a.includes("See all"));
      expect(href(seeAll!)).toBe(section.tagHref);
      from = at;
    }
  });

  it("draws each card's tag as a Capsomer outline pill, and none for a post with no tag", () => {
    const body = beforeScript(html);
    expect(cards(body).length, "the page renders post cards").toBe(6);
    for (const c of cards(body)) {
      const pills = c.match(/<span class="cap-pill" data-variant="outline">/g) ?? [];
      expect(pills.length).toBe(href(c) === "/blog/latest-b" ? 0 : 1);
    }
  });

  it("makes every text link a 24px target (WCAG 2.2)", () => {
    const body = beforeScript(html);
    const textLinks = links(body).filter((a) => href(a) === "/blog/archive" || a.includes("See all"));
    expect(textLinks.length).toBeGreaterThan(0);
    for (const a of textLinks) expect(classOf(a).split(/\s+/)).toContain("leading-6");
  });
});

describe("/blog loader (J19, row M11)", () => {
  it("hides a section whose tag no published post carries, even when its curated posts resolve", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    // Two of Payment Recovery's curated posts are published but carry another
    // tag, so /blog/tag/payment-recovery would be empty or missing.
    await seed(db, "stripe-failed-payment-recovery", { tags: ["comparisons"] });
    await seed(db, "dunning-email-sequence", { tags: ["comparisons"] });
    // Dispute Handling's curated post carries its tag.
    await seed(db, "stripe-disputes-guide", { tags: ["disputes"] });
    const data = (await index.loader({ context } as never)) as Awaited<ReturnType<typeof index.loader>>;
    expect(data.sections.map((s) => s.section.id)).toEqual(["disputes"]);
  });

  it("hides a section whose tag only a draft carries", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seed(db, "stripe-disputes-guide", { tags: ["comparisons"] });
    await seed(db, "a-draft", { tags: ["disputes"], published: false });
    const data = (await index.loader({ context } as never)) as Awaited<ReturnType<typeof index.loader>>;
    expect(data.sections).toEqual([]);
  });
});

async function tagLoader(t: string) {
  return tag.loader({ params: { tag: t }, context } as never).then(
    (data) => ({ data, status: 200 }),
    (err: unknown) => ({ data: null, status: err instanceof Response ? err.status : -1 }),
  );
}

describe("/blog/tag/:tag loader (J19, row M14)", () => {
  it("answers 404 for a tag no published post carries, canonical or not", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seed(db, "a", { tags: ["payment-recovery"] });
    await seed(db, "draft", { tags: ["saas-metrics"], published: false });
    expect((await tagLoader("saas-metrics")).status).toBe(404);
    expect((await tagLoader("no-such-tag")).status).toBe(404);
    expect((await tagLoader("payment-recovery")).status).toBe(200);
  });

  it("serves a tag any published post carries, from the same set the sitemap, feed and llms.txt read", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seed(db, "a", { tags: ["churn-basics"] });
    const res = await tagLoader("churn-basics");
    expect(res.status).toBe(200);
    expect((res.data as { posts: BlogPostSummary[] }).posts.map((p) => p.slug)).toEqual(["a"]);
  });
});

describe("excerpts on the index and tag pages go through Prelum (J19, DO step 3)", () => {
  it("renders each card's excerpt markdown to its words on the tag page", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seed(db, "a", { tags: ["disputes"] });
    await db.update(blogPosts).set({ excerpt: "Win **more** disputes, $49 at a time." });
    const res = await tagLoader("disputes");
    expect((res.data as { posts: BlogPostSummary[] }).posts[0].excerpt).toBe("Win more disputes, $49 at a time.");
  });

  it("renders the featured excerpt on /blog", async () => {
    const { db } = createInMemoryDb();
    harness.db = db;
    await seed(db, "stripe-disputes-guide", { tags: ["disputes"], featured: true });
    await db.update(blogPosts).set({ excerpt: "Read *this* first." });
    const data = (await index.loader({ context } as never)) as Awaited<ReturnType<typeof index.loader>>;
    expect(data.featured?.excerpt).toBe("Read this first.");
    expect(data.sections[0].posts[0].excerpt).toBe("Read this first.");
  });
});

describe("/blog/tag/:tag page (J19, row M14)", () => {
  const data = { siteUrl: "https://example.com", tag: "decline-codes", posts: [summary("a", ["decline-codes"]), summary("b", ["decline-codes"])] };
  const html = renderPage(tag.default as never, data, "/blog/tag/decline-codes");

  it("is built from Capsomer's parts, teal, on the five text sizes", () => {
    expectCapsomerLook(html);
  });

  it("keeps Recova's layout: one left-aligned 1100px column, the back link, the label as h1, then the count line", () => {
    const body = beforeScript(html);
    expect(body).not.toContain("text-center");
    const col = body.indexOf("max-w-[1100px]");
    expect(col).toBeGreaterThan(-1);
    const back = body.indexOf('href="/blog"', col);
    const h1 = body.indexOf("<h1", col);
    const count = body.indexOf("2 articles", col);
    const grid = body.indexOf("cap-panel", col);
    expect(back).toBeGreaterThan(col);
    expect(h1).toBeGreaterThan(back);
    expect(body.slice(h1, body.indexOf("</h1>", h1))).toContain("Decline Codes");
    expect(count).toBeGreaterThan(h1);
    expect(grid).toBeGreaterThan(count);
  });

  it("sets the count line at label size, as Recova's 0.8125rem", () => {
    const body = beforeScript(html);
    const p = body.slice(body.lastIndexOf("<p", body.indexOf("2 articles")), body.indexOf("2 articles"));
    expect(classOf(p).split(/\s+/)).toContain("text-label");
  });

  it("makes the back link a 24px target (WCAG 2.2)", () => {
    const back = links(beforeScript(html)).find((a) => href(a) === "/blog");
    expect(back).toContain("All posts");
    expect(classOf(back!).split(/\s+/)).toContain("leading-6");
  });
});
