import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DOCS_FIRST_PUBLISHED, DOC_GUIDES } from "~/lib/marketing/docs-content";
import { breadcrumbListJsonLd, docsItemListJsonLd, techArticleJsonLd } from "~/lib/seo/jsonld";
import { STATIC_PAGES } from "~/routes/files/sitemap";

// 368 ROADMAP ITEM 2's REMAINDER: the docs guides had no structured data.
//
// WHAT SESSION 73 MEASURED. Marketing pages carry eleven @types between them
// (Organization, SoftwareApplication, WebSite, WebPage, FAQPage, Question,
// Answer, Offer, ContactPoint, SpeakableSpecification, BreadcrumbList). The five
// guides carried ZERO, and they are the pages an AI most wants to cite: they are
// the only place the product's behaviour is written down in prose.
//
// THE TYPE IS TechArticle, and that is the site's vocabulary applied rather than
// a new one invented. BlogPosting claims a dated editorial post with an author,
// which a house user guide is not; a bare WebPage says nothing about the page
// being documentation. TechArticle is Article's documentation subtype.
//
// THE PLANT IS DERIVED FROM DOC_GUIDES, so a sixth guide is covered the day it
// is added rather than the day somebody remembers to add a case.

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8");

const GUIDE_ROUTE = read("app/routes/docs/page.tsx");
const INDEX_ROUTE = read("app/routes/docs/index.tsx");

const URL_BASE = "https://foxhoundapp.test";

describe("PLANT 1: every guide's JSON-LD, built from the real builders", () => {
  it("the fixture is non-empty, so an empty loop cannot read as a pass", () => {
    expect(DOC_GUIDES.length).toBe(5);
    expect(DOCS_FIRST_PUBLISHED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("EVERY GUIDE emits a TechArticle whose headline is the page h1", () => {
    // THE HEADLINE AND THE H1 ARE ONE VARIABLE in the route (`guide.title` feeds
    // both), which is the property that makes them unable to drift. This asserts
    // the value AND that the route reads it from the same place.
    for (const guide of DOC_GUIDES) {
      const block = techArticleJsonLd(URL_BASE, {
        headline: guide.heading,
        description: guide.description,
        path: `/docs/${guide.slug}`,
        datePublished: guide.datePublished,
      });
      expect(block["@type"]).toBe("TechArticle");
      expect(block.headline, `${guide.slug} headline`).toBe(guide.heading);
      expect(block.description).toBe(guide.description);
      expect(block.url).toBe(`${URL_BASE}/docs/${guide.slug}`);
      expect(block.datePublished).toBe(DOCS_FIRST_PUBLISHED);
      expect(block.publisher).toEqual({ "@id": `${URL_BASE}/#organization` });
    }
    // And the route really does feed the h1 and the headline from one value.
    // J73: the h1 is Recova's page heading ("Platform setup"), so the
    // headline follows it rather than the card title.
    expect(GUIDE_ROUTE).toContain("headline: guide.heading");
    expect(GUIDE_ROUTE).toContain("<h1");
    expect(GUIDE_ROUTE).toContain(">{guide.heading}</h1>");
  });

  it("EVERY BLOCK PARSES, which a hand-built string would not guarantee", () => {
    for (const guide of DOC_GUIDES) {
      const payload = JSON.stringify([
        techArticleJsonLd(URL_BASE, {
          headline: guide.heading,
          description: guide.description,
          path: `/docs/${guide.slug}`,
          datePublished: guide.datePublished,
        }),
        breadcrumbListJsonLd(URL_BASE, [
          { name: "Docs", path: "/docs" },
          { name: guide.title, path: `/docs/${guide.slug}` },
        ]),
      ]);
      const parsed = JSON.parse(payload) as { "@type": string }[];
      expect(parsed).toHaveLength(2);
      expect(parsed.map((b) => b["@type"])).toEqual(["TechArticle", "BreadcrumbList"]);
    }
  });

  it("the breadcrumb matches the one the page RENDERS, Docs then the title", () => {
    const crumbs = breadcrumbListJsonLd(URL_BASE, [
      { name: "Docs", path: "/docs" },
      { name: "Audit", path: "/docs/audit" },
    ]);
    expect(crumbs.itemListElement.map((i) => i.name)).toEqual(["Docs", "Audit"]);
    expect(crumbs.itemListElement[0].item).toBe(`${URL_BASE}/docs`);
    // The visible breadcrumb the route draws, so the two cannot say different
    // things to a person and to a crawler.
    // J73: Capsomer's Breadcrumb draws the nav (aria-label="Breadcrumb", its
    // own contract in breadcrumb.md); the route hands it Docs then the title.
    expect(GUIDE_ROUTE).toContain('from "capsomer/react/breadcrumb"');
    expect(GUIDE_ROUTE).toContain('{ label: "Docs", href: "/docs" }, { label: guide.title }');
  });

  it("EXACTLY ONE JSON-LD SCRIPT PER ROUTE, matching how marketing emits", () => {
    // Two blocks in one array, not two script tags: the pattern every marketing
    // page uses (routes/home.tsx). Counted, because a second tag is the shape a
    // careless addition takes.
    for (const [name, source] of [
      ["guide", GUIDE_ROUTE],
      ["index", INDEX_ROUTE],
    ] as const) {
      const tags = source.match(/type="application\/ld\+json"/g) ?? [];
      expect(tags, `${name} route emits ${tags.length} blocks`).toHaveLength(1);
    }
  });
});

describe("PLANT 2: the docs index emits its list", () => {
  it("an ItemList carrying every guide, in render order", () => {
    const list = docsItemListJsonLd(URL_BASE, DOC_GUIDES);
    expect(list["@type"]).toBe("ItemList");
    expect(list.itemListElement).toHaveLength(DOC_GUIDES.length);
    expect(list.itemListElement.map((i) => i.name)).toEqual(DOC_GUIDES.map((g) => g.title));
    expect(list.itemListElement.map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
    for (const item of list.itemListElement) {
      expect(item.url.startsWith(`${URL_BASE}/docs/`)).toBe(true);
    }
  });

  it("DERIVED FROM DOC_GUIDES, so a sixth guide joins without a code change", () => {
    // Passing the constant itself is what makes this true; a hand-listed array
    // in the route would have to be maintained twice.
    expect(INDEX_ROUTE).toContain("docsItemListJsonLd(url, DOC_GUIDES)");
  });
});

describe("PLANT 3: the date is measured, not invented", () => {
  it("every guide carries the same measured first-published date", () => {
    // All five first appear in commit 5478d6b. If a guide ever ships later it
    // gets its own date, and this assertion is what forces that to be a decision
    // rather than an oversight.
    for (const guide of DOC_GUIDES) {
      expect(guide.datePublished, `${guide.slug} has no date`).toBe(DOCS_FIRST_PUBLISHED);
    }
  });

  it("NO dateModified IS EMITTED, because nothing tracks one", () => {
    // The honest absence. A fabricated revision timestamp in a file built to be
    // quoted by machines is worse than no timestamp at all.
    const block = techArticleJsonLd(URL_BASE, {
      headline: "Audit",
      description: "d",
      path: "/docs/audit",
      datePublished: DOCS_FIRST_PUBLISHED,
    }) as Record<string, unknown>;
    expect(block.dateModified).toBeUndefined();
    expect(block.author).toBeUndefined();
  });
});

describe("PLANT 4: the guides stayed indexable, which the fix must not change", () => {
  it("every guide is still in the sitemap", () => {
    // The hub is a STATIC_PAGES entry; the five guides are mapped from
    // DOC_GUIDES into `docEntries` and merged in the route, so the assertion is
    // against the ROUTE's own derivation rather than the static list, which
    // never held them.
    expect(STATIC_PAGES.map((p) => p.path)).toContain("/docs");
    const sitemapSource = read("app/routes/files/sitemap.ts");
    expect(sitemapSource).toContain("DOC_GUIDES.map((g) => ({");
    expect(sitemapSource).toContain("path: `/docs/${g.slug}`");
  });
});
