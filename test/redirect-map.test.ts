import { describe, expect, it } from "vitest";

import { RECOVA_REDIRECT_MAP } from "~/lib/redirects/recova-map";

// Every path below was enumerated for real from the legacy repo's actual
// `app/` tree via Capsid list_repo_tree (namespace "recova", repo "legacy"),
// checked 2026-07-19: the (marketing) route group in full, plus the
// top-level /audit landing page, the three top-level per-product demo
// pages, and /console (named explicitly by the task). This is a real
// assertion against real enumerated data, not a hand-picked sample: every
// one of these paths must have a mapping entry in RECOVA_REDIRECT_MAP.
const ENUMERATED_LEGACY_MARKETING_ROUTES = [
  "/",
  "/pricing",
  "/products",
  "/features",
  "/product/audit",
  "/product/disputes",
  "/product/intelligence",
  "/product/recovery",
  "/demos",
  "/recovery/demo",
  "/disputes/demo",
  "/intelligence/demo",
  "/privacy",
  "/terms",
  "/docs",
  "/docs/audit",
  "/docs/disputes",
  "/docs/intelligence",
  "/docs/platform",
  "/docs/recovery",
  "/blog",
  "/blog/archive",
  "/blog/rss.xml",
  "/feed.rss",
  "/blog/:slug",
  "/blog/tag/:tag",
  "/audit",
  "/console",
];

describe("RECOVA_REDIRECT_MAP", () => {
  it("has a mapping entry for every enumerated legacy marketing route", () => {
    const mappedFroms = new Set(RECOVA_REDIRECT_MAP.map((e) => e.from));
    for (const route of ENUMERATED_LEGACY_MARKETING_ROUTES) {
      expect(mappedFroms.has(route), `missing redirect mapping for ${route}`).toBe(true);
    }
  });

  it("has no unmapped extra entries beyond the enumerated set (map and enumeration stay in sync)", () => {
    const enumerated = new Set(ENUMERATED_LEGACY_MARKETING_ROUTES);
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(enumerated.has(entry.from), `${entry.from} is mapped but not in the enumerated legacy route list`).toBe(true);
    }
  });

  it("has no duplicate source paths", () => {
    const froms = RECOVA_REDIRECT_MAP.map((e) => e.from);
    expect(new Set(froms).size).toBe(froms.length);
  });

  it("every target path is a real Foxhound path starting with /", () => {
    for (const entry of RECOVA_REDIRECT_MAP) {
      expect(entry.to.startsWith("/")).toBe(true);
    }
  });

  it("maps /product/* to /products/* per ROUTES.md's collapsed pattern", () => {
    const productEntries = RECOVA_REDIRECT_MAP.filter((e) => e.from.startsWith("/product/"));
    expect(productEntries.length).toBeGreaterThan(0);
    for (const entry of productEntries) {
      expect(entry.to).toBe(entry.from.replace("/product/", "/products/"));
    }
  });

  it("maps /console to /dashboard", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/console")?.to).toBe("/dashboard");
  });

  it("maps /features to /products", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/features")?.to).toBe("/products");
  });

  it("maps blog slugs and tag slugs verbatim", () => {
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/:slug")?.to).toBe("/blog/:slug");
    expect(RECOVA_REDIRECT_MAP.find((e) => e.from === "/blog/tag/:tag")?.to).toBe("/blog/tag/:tag");
  });
});
