// How the Recova -> Foxhound redirect map is made (CUTOVER-PLAN.md step 2,
// RULES.md 7.3: "The redirect map is regenerated, never hand-edited").
//
// app/lib/redirects/recova-map.ts is GENERATED from three inputs:
//   1. Recova's public routes, the snapshot in
//      test/fixtures/legacy-marketing-routes.ts (walked from Recova's own app/
//      tree; see that file's header for what was walked and its scope).
//   2. The paths Foxhound serves, read from app/routes.ts by the test.
//   3. Recova's seven config-level redirects from its next.config.ts, in
//      app/lib/redirects/recova-config-redirects.ts (J23, ledger row F17).
//      Each path rule maps straight to Recova's own destination, so a visitor
//      makes one hop and never lands on Foxhound's copy of the same redirect.
//      The host rule (app.recovamrr.com to the apex, path kept) becomes a
//      second host the whole map answers on.
//
// The rule is "same path, new domain": a Recova path
// Foxhound serves maps to itself. Only a Recova path Foxhound does NOT serve
// needs a named target, and each of those is listed below with its reason. An
// entry here for a path Foxhound now serves is stale and fails the build, so a
// rename on either side can never leave a detour in the map.
//
// test/redirect-map.test.ts renders the map with renderRecovaMapSource and
// compares it with the committed file byte for byte. `npm run gen:recova-map`
// rewrites the file from these inputs.

export interface RedirectMapEntry {
  /** Recova (recovamrr.com) path. A leading-colon segment (":slug", ":tag")
   *  is a dynamic route, mapped verbatim by segment, not a literal path. A
   *  trailing "/:path*" (Recova's next.config.ts form) matches the bare prefix
   *  and everything under it, carried over to the target's "/:path*". */
  from: string;
  /** Foxhound (foxhoundapp.com) path. */
  to: string;
  /** Present only when the mapping is not "same path". */
  note?: string;
}

import type { RecovaConfigRedirect } from "./recova-config-redirects";

export interface LegacyRoute {
  url: string;
  sourceFile: string;
}

const DEMO_NOTE =
  "Recova's separate per-product demo pages collapse onto Foxhound's single /demos entry point; the per-product /demos/* links set a cookie and redirect again, which would make a chain.";

/** Recova paths with no page at the same Foxhound path, and where each goes. */
const NOT_SERVED_AT_SAME_PATH: Readonly<Record<string, { to: string; note: string }>> = {
  "/blog/rss.xml": { to: "/feed.rss", note: "Foxhound has one RSS route, /feed.rss, not a separate per-section feed." },
  "/blog/sitemap.xml": {
    to: "/sitemap.xml",
    note: "Foxhound has one sitemap that already includes every blog post, not a separate per-section sitemap.",
  },
  "/recovery/demo": { to: "/demos", note: DEMO_NOTE },
  "/disputes/demo": { to: "/demos", note: DEMO_NOTE },
  "/intelligence/demo": { to: "/demos", note: DEMO_NOTE },
};

/** A path with every dynamic segment reduced to ":", so /blog/:slug and
 *  /blog/:post compare equal. */
function routeShape(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? ":" : segment))
    .join("/");
}

const CONFIG_NOTE = "One of Recova's own next.config.ts redirects, mapped straight to Recova's destination so it is one hop.";

const PATH_SPLAT = "/:path*";

export function deriveRecovaMap(
  legacy: readonly LegacyRoute[],
  foxhoundPaths: Iterable<string>,
  config: readonly RecovaConfigRedirect[],
): RedirectMapEntry[] {
  const served = new Set([...foxhoundPaths].map(routeShape));
  const entries: RedirectMapEntry[] = [];
  for (const route of legacy) {
    const override = NOT_SERVED_AT_SAME_PATH[route.url];
    if (served.has(routeShape(route.url))) {
      if (override) {
        throw new Error(`${route.url} is served by Foxhound at the same path; its NOT_SERVED_AT_SAME_PATH entry is stale.`);
      }
      entries.push({ from: route.url, to: route.url });
      continue;
    }
    if (!override) {
      throw new Error(`${route.url} (${route.sourceFile}) has no Foxhound page at the same path and no named target.`);
    }
    if (!served.has(routeShape(override.to))) {
      throw new Error(`${route.url} is mapped to ${override.to}, which Foxhound does not serve.`);
    }
    entries.push({ from: route.url, to: override.to, note: override.note });
  }
  const legacyUrls = new Set(legacy.map((r) => r.url));
  const configSources = new Set(config.filter((r) => !r.host).map((r) => r.source));
  for (const rule of config) {
    if (rule.host) continue;
    const where = `Recova's next.config.ts redirect ${rule.source} -> ${rule.destination}`;
    if (!rule.destination.startsWith("/") || rule.destination.startsWith("//")) {
      throw new Error(`${where} does not target a fixed path on the site.`);
    }
    // Ruling 408 binding 4: no many-to-one dumps onto the home page. Not
    // decided here; a rule like this is for Dustin.
    if (rule.destination === "/") throw new Error(`${where} redirects onto the home page (ruling 408 binding 4).`);
    if (rule.source.endsWith(PATH_SPLAT) !== rule.destination.endsWith(PATH_SPLAT)) {
      throw new Error(`${where} keeps the path on one side only.`);
    }
    if (!served.has(routeShape(rule.destination))) throw new Error(`${where}: Foxhound does not serve the target.`);
    if (configSources.has(rule.destination)) throw new Error(`${where} lands on another redirect, a chain.`);
    if (legacyUrls.has(rule.source)) throw new Error(`${where} shadows a Recova page of the same path.`);
    entries.push({ from: rule.source, to: rule.destination, note: CONFIG_NOTE });
  }
  for (const url of Object.keys(NOT_SERVED_AT_SAME_PATH)) {
    if (!legacyUrls.has(url)) throw new Error(`${url} is in NOT_SERVED_AT_SAME_PATH but not a Recova route.`);
  }
  return entries;
}
