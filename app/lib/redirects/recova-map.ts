// Legacy (recovamrr.com) -> Foxhound (foxhoundapp.com) 301 redirect map, data
// only (ROUTES.md "Redirect map ownership": "Phase 6 builds the ... map as
// data ... served at cutover"). NOT wired to serve anywhere in this pass; no
// changes to app/routes.ts for redirects. Phase 9 turns it on at cutover.
//
// Every entry below is asserted, in test/redirect-map.test.ts, against
// test/fixtures/legacy-marketing-routes.ts: a snapshot of the legacy repo's
// actual `app/` tree (Capsid list_repo_tree, namespace "recova", repo
// "legacy"), not a hand-typed list that happens to match this file. If a
// legacy route is missing a mapping, or this map has an entry the fixture
// doesn't recognize, the test fails. Regenerate the fixture (and add a
// mapping here) when the legacy tree changes; see that file's own header
// for exactly what was walked and the scope rule.
//
// Scope (mirrors the fixture): every legacy MARKETING route (the
// (marketing) route group), four top-level marketing-style public surfaces
// outside that group (/audit landing, the three per-product /demo landing
// pages, /feed.rss), four top-level SEO/utility file routes with a direct
// Foxhound equivalent at the same path (/sitemap.xml, /robots.txt,
// /llms.txt, /llms-full.txt), and one explicitly named non-marketing
// anchor the task calls out directly: /console -> /dashboard. Everything
// else under the legacy app tree (app/(app)/*, app/admin, app/api,
// app/auth, app/oauth, app/invite, app/welcome,
// app/audit/{connect,dashboard,results,callback}, app/connect, and every
// demo tree's nested sub-pages) is the authenticated app, admin, or MCP
// surface, or demo-internal navigation, out of this pass's stated scope.
//
// Rules applied (per TASK-foxhound-phase6.md):
//   - Blog post slugs and tag slugs map verbatim: same slug, new prefix only.
//   - /product/* -> /products/* (ROUTES.md: legacy's three duplicate trees,
//     /product/*, /products, /features, collapse onto one pattern).
//   - /features -> /products (folds into the products index).
//   - /console -> /dashboard (named explicitly by the task).
//   - Legacy archive/rss/sitemap paths -> the new equivalents:
//     /blog/archive has no new-canon target (ROUTES.md lists no archive
//     route), so it maps to /blog itself; /blog/rss.xml -> /feed.rss
//     (Foxhound's one RSS route); /blog/sitemap.xml -> /sitemap.xml
//     (Foxhound's one sitemap already includes every blog post, same
//     one-route consolidation as the RSS case).
//   - The four top-level SEO/utility files (sitemap.xml, robots.txt,
//     llms.txt, llms-full.txt) self-map: Foxhound serves the identical
//     path, so a crawler hitting the old domain still lands correctly.
//   - Legacy's three separate interactive-demo pages (/recovery/demo,
//     /disputes/demo, /intelligence/demo) collapse onto Foxhound's single
//     /demos entry point (ROUTES.md: "/demos, interactive demo entry"),
//     which is not a 1:1 rename, so it is called out here explicitly.

export interface RedirectMapEntry {
  /** Legacy recovamrr.com path. A leading-colon path segment (":slug", ":tag")
   *  represents a dynamic route, mapped verbatim by segment name, not a
   *  literal path. */
  from: string;
  /** New foxhoundapp.com path. */
  to: string;
  /** Present only when the mapping is not an obvious 1:1 rename. */
  note?: string;
}

export const RECOVA_REDIRECT_MAP: RedirectMapEntry[] = [
  { from: "/", to: "/" },
  { from: "/pricing", to: "/pricing" },
  { from: "/products", to: "/products" },
  { from: "/features", to: "/products", note: "Legacy /features folds into the /products index (ROUTES.md)." },
  { from: "/product/audit", to: "/products/audit" },
  { from: "/product/disputes", to: "/products/disputes" },
  { from: "/product/intelligence", to: "/products/intelligence" },
  { from: "/product/recovery", to: "/products/recovery" },
  { from: "/demos", to: "/demos" },
  {
    from: "/recovery/demo",
    to: "/demos",
    note: "Legacy's separate per-product demo pages collapse onto Foxhound's single /demos entry point; not a 1:1 rename.",
  },
  {
    from: "/disputes/demo",
    to: "/demos",
    note: "Legacy's separate per-product demo pages collapse onto Foxhound's single /demos entry point; not a 1:1 rename.",
  },
  {
    from: "/intelligence/demo",
    to: "/demos",
    note: "Legacy's separate per-product demo pages collapse onto Foxhound's single /demos entry point; not a 1:1 rename.",
  },
  { from: "/privacy", to: "/privacy" },
  { from: "/terms", to: "/terms" },
  { from: "/docs", to: "/docs" },
  { from: "/docs/audit", to: "/docs/audit" },
  { from: "/docs/disputes", to: "/docs/disputes" },
  { from: "/docs/intelligence", to: "/docs/intelligence" },
  { from: "/docs/platform", to: "/docs/platform" },
  { from: "/docs/recovery", to: "/docs/recovery" },
  { from: "/blog", to: "/blog" },
  {
    from: "/blog/archive",
    to: "/blog",
    note: "ROUTES.md lists no archive route for Foxhound (Pass 2 deliberately dropped it); /blog is the closest new-canon target.",
  },
  { from: "/blog/rss.xml", to: "/feed.rss", note: "Foxhound has one RSS route, /feed.rss, not a separate per-section feed." },
  {
    from: "/blog/sitemap.xml",
    to: "/sitemap.xml",
    note: "Foxhound has one sitemap that already includes every blog post, not a separate per-section sitemap.",
  },
  { from: "/feed.rss", to: "/feed.rss" },
  { from: "/sitemap.xml", to: "/sitemap.xml" },
  { from: "/robots.txt", to: "/robots.txt" },
  { from: "/llms.txt", to: "/llms.txt" },
  { from: "/llms-full.txt", to: "/llms-full.txt" },
  { from: "/blog/:slug", to: "/blog/:slug", note: "Blog post slugs map verbatim." },
  { from: "/blog/tag/:tag", to: "/blog/tag/:tag", note: "Tag archive slugs map verbatim." },
  { from: "/audit", to: "/audit" },
  { from: "/console", to: "/dashboard", note: "Named explicitly by the task; kills the legacy console/dashboard split (ROUTES.md)." },
];
