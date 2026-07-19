// Legacy (recovamrr.com) -> Foxhound (foxhoundapp.com) 301 redirect map, data
// only (ROUTES.md "Redirect map ownership": "Phase 6 builds the ... map as
// data ... served at cutover"). NOT wired to serve anywhere in this pass; no
// changes to app/routes.ts for redirects. Phase 9 turns it on at cutover.
//
// Every entry below was enumerated for real from the legacy repo's actual
// `app/` tree (Capsid list_repo_tree, namespace "recova", repo "legacy",
// checked 2026-07-19), not hand-picked. See test/redirect-map.test.ts for
// the literal enumerated list this map is asserted against.
//
// Scope: every legacy MARKETING route (the (marketing) route group, plus
// the top-level /audit landing page and the three top-level demo pages,
// which are public marketing-style surfaces outside that group), plus one
// explicitly named non-marketing anchor the task calls out directly:
// /console -> /dashboard. Everything else under the legacy app tree
// (app/(app)/*, app/admin, app/api, app/auth, app/oauth, app/invite,
// app/welcome, app/audit/{connect,dashboard,results,callback}, app/connect)
// is the authenticated app, admin, or MCP surface, out of this pass's
// stated scope ("every legacy marketing route"), and is not enumerated
// here.
//
// Rules applied (per TASK-foxhound-phase6.md):
//   - Blog post slugs and tag slugs map verbatim: same slug, new prefix only.
//   - /product/* -> /products/* (ROUTES.md: legacy's three duplicate trees,
//     /product/*, /products, /features, collapse onto one pattern).
//   - /features -> /products (folds into the products index).
//   - /console -> /dashboard (named explicitly by the task).
//   - Legacy archive/rss paths -> the new equivalents: /blog/archive has no
//     new-canon target (ROUTES.md lists no archive route), so it maps to
//     /blog itself; /blog/rss.xml -> /feed.rss (Foxhound's one RSS route).
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
  { from: "/feed.rss", to: "/feed.rss" },
  { from: "/blog/:slug", to: "/blog/:slug", note: "Blog post slugs map verbatim." },
  { from: "/blog/tag/:tag", to: "/blog/tag/:tag", note: "Tag archive slugs map verbatim." },
  { from: "/audit", to: "/audit" },
  { from: "/console", to: "/dashboard", note: "Named explicitly by the task; kills the legacy console/dashboard split (ROUTES.md)." },
];
