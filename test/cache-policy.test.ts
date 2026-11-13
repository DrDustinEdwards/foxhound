import { readFileSync } from "node:fs";
import { join } from "node:path";

import { matchRoutes, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";

import routes from "~/routes";
import { STATIC_PAGES } from "~/routes/files/sitemap";

// The cache rule is the network's (site-runtime ./worker and ./edge-cache, tested there): a route whose `headers` is
// publicPageHeaders() is stored at the edge and handed to every anonymous reader; every other answer leaves private,
// no-store. What is Foxhound's is WHICH routes say so, and a mistake there cannot be undone: a page drawn for one reader
// and marked public is stored and served to strangers (CLAUDE.md hard rule 9). Read from source, as the route modules
// pull in the whole app.

type Entry = { file: string; path?: string; index?: boolean; children?: Entry[] };

const APP = join(__dirname, "../app");
const source = (file: string) => readFileSync(join(APP, file), "utf8");
const PUBLIC = /export const headers = \(\) => publicPageHeaders\(\);/;
const PRIVATE = /export const headers = \(\) => PRIVATE_PAGE_HEADERS;/;

/** The route tree with each route's module file as its id. */
function tree(entries: Entry[]): RouteObject[] {
  return entries.map((entry) =>
    entry.index
      ? { id: entry.file, index: true, path: entry.path }
      : { id: entry.file, path: entry.path, children: tree(entry.children ?? []) },
  );
}
const ROUTES = tree(routes as Entry[]);

/** Every module in the tree, with the layouts above it. */
function walk(entries: Entry[], above: string[] = []): { file: string; above: string[] }[] {
  return entries.flatMap((entry) => [
    { file: entry.file, above },
    ...walk(entry.children ?? [], [...above, entry.file]),
  ]);
}

const PRIVATE_LAYOUTS = [
  "./layouts/app-shell.tsx",
  "./layouts/admin-shell.tsx",
  "./layouts/auth.tsx",
];

describe("PLANT 5: every page in the sitemap is stored for every reader", () => {
  // /security once shipped in the sitemap and was served private, no-store, because nobody listed it.
  it("each STATIC_PAGES path lands on a route whose headers are publicPageHeaders", () => {
    expect(STATIC_PAGES.length).toBeGreaterThan(5);
    for (const { path } of STATIC_PAGES) {
      const matched = matchRoutes(ROUTES, path);
      const leaf = matched?.at(-1)?.route.id;
      expect(leaf, `${path} matches no route`).toBeTruthy();
      expect(source(leaf!), `${path} (${leaf}) is in the sitemap but not marked public`).toMatch(
        PUBLIC,
      );
    }
  });
});

describe("PLANT 9: nothing drawn for one reader is marked public", () => {
  it("the signed-in, admin and sign-in layouts are private and untransformed", () => {
    for (const layout of PRIVATE_LAYOUTS) expect(source(layout), layout).toMatch(PRIVATE);
  });

  it("no route under them is marked public", () => {
    for (const { file, above } of walk(routes as Entry[])) {
      if (above.some((layout) => PRIVATE_LAYOUTS.includes(layout)))
        expect(source(file), file).not.toMatch(PUBLIC);
    }
  });

  it("the token and consent pages outside them are private and untransformed", () => {
    for (const file of [
      "./routes/auth/invite.tsx",
      "./routes/oauth/authorize.tsx",
      "./routes/utility/unsubscribe.tsx",
      "./routes/utility/card-update.tsx",
    ])
      expect(source(file), file).toMatch(PRIVATE);
  });
});
