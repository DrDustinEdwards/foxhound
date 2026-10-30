import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DOCS_FIRST_PUBLISHED, DOC_GUIDES } from "~/lib/marketing/docs-content";
import { docsItemListJsonLd, techArticleJsonLd } from "~/lib/seo/jsonld";
import { STATIC_PAGES } from "~/routes/files/sitemap";

// 368 ROADMAP ITEM 2's REMAINDER: the docs guides had no structured data.
//
// WHAT SESSION 73 MEASURED. Marketing pages carry eleven @types between them
// (Organization, SoftwareApplication, WebSite, WebPage, FAQPage, Question,
// Answer, Offer, ContactPoint, SpeakableSpecification, BreadcrumbList). The five
// guides carried ZERO, and they are the pages an AI most wants to cite: they are
// the only place the product's behavior is written down in prose.
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

const URL_BASE = "https://foxhoundapp.test";

describe("PLANT 1: every guide's JSON-LD, built from the real builders", () => {

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
});

describe("PLANT 2: the docs index emits its list", () => {
  it("an ItemList carrying every guide, in render order", () => {
    const list = docsItemListJsonLd(URL_BASE, DOC_GUIDES);
    const items = list.itemListElement as { name: string; position: number; url: string }[];
    expect(list["@type"]).toBe("ItemList");
    expect(items).toHaveLength(DOC_GUIDES.length);
    expect(items.map((i) => i.name)).toEqual(DOC_GUIDES.map((g) => g.title));
    expect(items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
    for (const item of items) {
      expect(item.url.startsWith(`${URL_BASE}/docs/`)).toBe(true);
    }
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
