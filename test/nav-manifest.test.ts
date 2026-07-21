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
});
