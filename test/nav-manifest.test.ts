import { describe, expect, it } from "vitest";

import { PLATFORM_LINKS, PRODUCT_MANIFEST } from "~/lib/nav/manifest";
import routes from "~/routes";

// Structural regression guard (task Part 2 rule 3): "a unit test asserts
// every manifest href exists in the route tree so nav and routes cannot
// drift." Walks the real app/routes.ts config and reconstructs every static
// full path, then checks every manifest href/to against that set.

interface RouteConfigEntry {
  path?: string;
  index?: boolean;
  file?: string;
  children?: RouteConfigEntry[];
}

function collectPaths(entries: RouteConfigEntry[], parentPath: string, out: Set<string>): void {
  for (const entry of entries) {
    // An index route can also carry a path (prefix() bakes the full relative
    // path onto every entry it wraps, including its index), so path always
    // wins when present; a bare index (no path) resolves to its parent's path.
    let path = parentPath;
    if (entry.path) {
      const segment = entry.path.replace(/^\/+|\/+$/g, "");
      path = parentPath === "" ? `/${segment}` : `${parentPath}/${segment}`;
      out.add(path);
    } else if (entry.index) {
      out.add(parentPath === "" ? "/" : parentPath);
    }
    if (entry.children) collectPaths(entry.children, path, out);
  }
}

function findByFile(entries: RouteConfigEntry[], file: string): RouteConfigEntry | null {
  for (const entry of entries) {
    if (entry.file === file) return entry;
    if (entry.children) {
      const found = findByFile(entry.children, file);
      if (found) return found;
    }
  }
  return null;
}

// Reverse-direction guard (port review finding 10): the forward check above
// only proves a manifest entry points somewhere real; it would not catch a
// real nav-worthy route being silently dropped FROM the manifest. Walks only
// the app-shell subtree (marketing/admin/webhook/utility routes have no
// product-switcher or platform-link presence to check), skips the
// admin-guard subtree (admin keeps its own AdminNav, task Part 2 rule:
// "do not rebuild its structure"), and skips any path containing a dynamic
// segment (a :id detail page is never itself a nav destination).
const ADMIN_GUARD_FILE = "./layouts/admin-guard.tsx";

// Routes intentionally absent from the nav manifest: reached by redirect or
// one-time flow, never a persistent switcher/platform-link destination.
const NAV_EXCLUDED_ROUTES = new Set([
  "/welcome", // onboarding entry point immediately after signup
]);

function collectNavCandidatePaths(entries: RouteConfigEntry[], parentPath: string, out: Set<string>): void {
  for (const entry of entries) {
    if (entry.file === ADMIN_GUARD_FILE) continue;
    let path = parentPath;
    if (entry.path) {
      const segment = entry.path.replace(/^\/+|\/+$/g, "");
      path = parentPath === "" ? `/${segment}` : `${parentPath}/${segment}`;
      if (!path.includes(":")) out.add(path);
    } else if (entry.index) {
      const indexPath = parentPath === "" ? "/" : parentPath;
      if (!indexPath.includes(":")) out.add(indexPath);
    }
    if (entry.children) collectNavCandidatePaths(entry.children, path, out);
  }
}

describe("nav manifest matches routes.ts", () => {
  const realPaths = new Set<string>();
  collectPaths(routes as unknown as RouteConfigEntry[], "", realPaths);

  it("found a sane number of real routes (fixture is walking something)", () => {
    expect(realPaths.size).toBeGreaterThan(20);
  });

  it("every product manifest href is a real route", () => {
    for (const product of Object.values(PRODUCT_MANIFEST)) {
      expect(realPaths.has(product.href), `${product.href} (product: ${product.key}) is not in routes.ts`).toBe(
        true,
      );
    }
  });

  it("every product manifest sub-link is a real route", () => {
    for (const product of Object.values(PRODUCT_MANIFEST)) {
      for (const link of product.links) {
        expect(realPaths.has(link.to), `${link.to} (product: ${product.key}) is not in routes.ts`).toBe(true);
      }
    }
  });

  it("every platform link is a real route", () => {
    for (const link of PLATFORM_LINKS) {
      expect(realPaths.has(link.to), `${link.to} is not in routes.ts`).toBe(true);
    }
  });

  it("every real app-shell route (minus admin, dynamic segments, and the explicit onboarding exclusion) has a manifest entry", () => {
    const appShellNode = findByFile(routes as unknown as RouteConfigEntry[], "./layouts/app-shell.tsx");
    expect(appShellNode).not.toBeNull();

    const candidatePaths = new Set<string>();
    collectNavCandidatePaths(appShellNode!.children ?? [], "", candidatePaths);
    // Sanity: this must actually be walking something, or the assertions
    // below pass vacuously if app-shell.tsx ever gets renamed.
    expect(candidatePaths.size).toBeGreaterThan(5);

    const manifestPaths = new Set<string>([
      ...Object.values(PRODUCT_MANIFEST).flatMap((product) => [product.href, ...product.links.map((l) => l.to)]),
      ...PLATFORM_LINKS.map((link) => link.to),
    ]);

    for (const path of candidatePaths) {
      if (NAV_EXCLUDED_ROUTES.has(path)) continue;
      expect(
        manifestPaths.has(path),
        `${path} is a real app-shell route with no manifest entry (add it, or add it to NAV_EXCLUDED_ROUTES with a reason)`,
      ).toBe(true);
    }
  });
});
