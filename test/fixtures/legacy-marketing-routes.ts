// A snapshot of every legacy (recovamrr.com, DrDustinEdwards/recova) route
// this repo's redirect map (app/lib/redirects/recova-map.ts) is scoped to
// cover, derived from the ACTUAL legacy repo tree, not hand-typed to match
// the map. Regenerate by walking these paths with Capsid's list_repo_tree
// (namespace "recova", repo "legacy") and updating this file; the
// redirect-map test then fails loudly if the map falls out of sync with
// whatever this fixture says the legacy site's routes are.
//
// Snapshot taken 2026-07-19 via list_repo_tree against:
//   app/(marketing)  (recursively: blog, blog/[slug], blog/archive,
//     blog/tag/[tag], blog/rss.xml, blog/sitemap.ts, demos, docs +
//     5 guide subdirs, features, pricing, privacy, product + 4 subdirs,
//     products, terms)
//   app  (top level, to find audit/console/demo/SEO-file siblings outside
//     the (marketing) group)
//   app/recovery/demo, app/disputes/demo, app/intelligence/demo
//   app/audit, app/feed.rss, app/llms.txt, app/llms-full.txt
//   app/(app)/console
//
// SCOPE (matches recova-map.ts's own documented scope, do not silently
// widen or narrow without updating both files together):
//   1. Every page under the app/(marketing) route group (route groups
//      "(x)" do not appear in the URL).
//   2. Four top-level marketing-style public surfaces the task/canon single
//      out by name even though they sit outside the (marketing) group:
//      the /audit landing page (its post-auth subroutes connect/callback/
//      dashboard/results are the authenticated flow, out of scope, same
//      as app/connect and app/(app)/* generally), the three per-product
//      /demo landing pages (their nested demo sub-pages -- alerts, help,
//      payments, sequence, churn, context, customers, dashboard, narrative,
//      recommendations, [id] -- are demo-internal navigation, not distinct
//      marketing routes, out of scope), and /feed.rss.
//   3. Top-level public SEO/utility file routes with a direct Foxhound
//      equivalent at the identical path (sitemap.ts -> /sitemap.xml,
//      robots.ts -> /robots.txt, llms.txt, llms-full.txt, and since ruling
//      41's entry app/og/route.tsx -> /og): included so a
//      crawler hitting any of these on the old domain also gets a 301
//      rather than a 404.
//   4. /console (app/(app)/console), named explicitly by
//      TASK-foxhound-phase6.md as the one authenticated-surface exception.
//
// Everything else (app/(app)/*, app/admin, app/api, app/auth, app/oauth,
// app/invite, app/welcome, app/connect, app/audit/{connect,dashboard,
// results,callback}, and every demo tree's nested sub-pages) is the
// authenticated app, admin, or MCP surface, or demo-internal navigation,
// and stays out of this pass's "every legacy marketing route" scope.

export interface LegacyRouteFixtureEntry {
  /** The URL path this legacy file/folder actually serves. */
  url: string;
  /** The legacy repo file whose existence (via Next.js file-based routing
   *  conventions: route groups are invisible in the URL, [x] segments
   *  become dynamic params, page.tsx/route.ts serve their containing
   *  directory's path, and a bare metadata-route file like sitemap.ts
   *  serves its own directory at a fixed extension) produces this URL. */
  sourceFile: string;
}

export const LEGACY_MARKETING_ROUTES: LegacyRouteFixtureEntry[] = [
  // app/(marketing) root + top-level pages
  { url: "/", sourceFile: "app/(marketing)/page.tsx" },
  { url: "/pricing", sourceFile: "app/(marketing)/pricing/page.tsx" },
  { url: "/products", sourceFile: "app/(marketing)/products/page.tsx" },
  { url: "/features", sourceFile: "app/(marketing)/features/page.tsx" },
  { url: "/product/audit", sourceFile: "app/(marketing)/product/audit/page.tsx" },
  { url: "/product/disputes", sourceFile: "app/(marketing)/product/disputes/page.tsx" },
  { url: "/product/intelligence", sourceFile: "app/(marketing)/product/intelligence/page.tsx" },
  { url: "/product/recovery", sourceFile: "app/(marketing)/product/recovery/page.tsx" },
  { url: "/demos", sourceFile: "app/(marketing)/demos/page.tsx" },
  { url: "/privacy", sourceFile: "app/(marketing)/privacy/page.tsx" },
  { url: "/terms", sourceFile: "app/(marketing)/terms/page.tsx" },

  // app/(marketing)/docs + 5 guide subdirs
  { url: "/docs", sourceFile: "app/(marketing)/docs/page.tsx" },
  { url: "/docs/audit", sourceFile: "app/(marketing)/docs/audit/page.tsx" },
  { url: "/docs/disputes", sourceFile: "app/(marketing)/docs/disputes/page.tsx" },
  { url: "/docs/intelligence", sourceFile: "app/(marketing)/docs/intelligence/page.tsx" },
  { url: "/docs/platform", sourceFile: "app/(marketing)/docs/platform/page.tsx" },
  { url: "/docs/recovery", sourceFile: "app/(marketing)/docs/recovery/page.tsx" },

  // app/(marketing)/blog + dynamic/nested routes
  { url: "/blog", sourceFile: "app/(marketing)/blog/page.tsx" },
  { url: "/blog/:slug", sourceFile: "app/(marketing)/blog/[slug]/page.tsx" },
  { url: "/blog/archive", sourceFile: "app/(marketing)/blog/archive/page.tsx" },
  { url: "/blog/tag/:tag", sourceFile: "app/(marketing)/blog/tag/[tag]/page.tsx" },
  { url: "/blog/rss.xml", sourceFile: "app/(marketing)/blog/rss.xml/route.ts" },
  { url: "/blog/sitemap.xml", sourceFile: "app/(marketing)/blog/sitemap.ts" },

  // Top-level marketing-style exceptions outside the (marketing) group
  { url: "/audit", sourceFile: "app/audit/page.tsx" },
  { url: "/recovery/demo", sourceFile: "app/recovery/demo/page.tsx" },
  { url: "/disputes/demo", sourceFile: "app/disputes/demo/page.tsx" },
  { url: "/intelligence/demo", sourceFile: "app/intelligence/demo/page.tsx" },
  { url: "/feed.rss", sourceFile: "app/feed.rss/route.ts" },

  // Top-level SEO/utility file routes (self-mapped equivalents on Foxhound)
  { url: "/sitemap.xml", sourceFile: "app/sitemap.ts" },
  { url: "/robots.txt", sourceFile: "app/robots.ts" },
  { url: "/llms.txt", sourceFile: "app/llms.txt/route.ts" },
  { url: "/llms-full.txt", sourceFile: "app/llms-full.txt/route.ts" },
  // Recova's social card image (ruling 41, row F6): /og and /og?type=blog
  // are already embedded in shared links and third-party caches, so the old
  // URL has to keep answering after the move.
  { url: "/og", sourceFile: "app/og/route.tsx" },

  // The one named authenticated-surface exception (TASK-foxhound-phase6.md)
  { url: "/console", sourceFile: "app/(app)/console/page.tsx" },
];
