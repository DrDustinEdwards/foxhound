import { describe, expect, it } from "vitest";

import { NAV_LINKS } from "~/components/header";
import { COLUMNS } from "~/components/footer";
import routes from "~/routes";

// Drift-prevention guard for the marketing chrome (same pattern as
// test/nav-manifest.test.ts, which covers only the app-shell subtree):
// TASK-foxhound-marketing-nav-parity.md asks that every header/footer href
// resolve in the real route tree, so a future edit to either can't silently
// point at a route that does not exist.

interface RouteConfigEntry {
  path?: string;
  index?: boolean;
  file?: string;
  children?: RouteConfigEntry[];
}

function collectPaths(entries: RouteConfigEntry[], parentPath: string, out: Set<string>): void {
  for (const entry of entries) {
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

// The header's non-NAV_LINKS hrefs: the wordmark home link and the
// auth-state-dependent CTAs (Sign in / Free audit / Dashboard render
// conditionally, but all four hrefs are real regardless of which branch is
// active for a given visitor).
const HEADER_STATIC_LINKS = ["/", "/login", "/audit", "/dashboard"];

describe("marketing header + footer links match routes.ts", () => {
  const realPaths = new Set<string>();
  collectPaths(routes as unknown as RouteConfigEntry[], "", realPaths);

  it("found a sane number of real routes (fixture is walking something)", () => {
    expect(realPaths.size).toBeGreaterThan(20);
  });

  it("every header nav link is a real route", () => {
    for (const link of NAV_LINKS) {
      expect(realPaths.has(link.to), `${link.to} (header nav) is not in routes.ts`).toBe(true);
    }
  });

  it("every header static/CTA link is a real route", () => {
    for (const to of HEADER_STATIC_LINKS) {
      expect(realPaths.has(to), `${to} (header static) is not in routes.ts`).toBe(true);
    }
  });

  it("every footer column link is a real route", () => {
    for (const column of COLUMNS) {
      for (const link of column.links) {
        expect(realPaths.has(link.to), `${link.to} (footer: ${column.heading}) is not in routes.ts`).toBe(true);
      }
    }
  });

  it("the footer has exactly the four legacy-parity columns", () => {
    expect(COLUMNS.map((c) => c.heading)).toEqual(["Product", "Explore", "Resources", "Legal"]);
  });

  it("header nav has Features between Demos and Docs (legacy position)", () => {
    const labels = NAV_LINKS.map((l) => l.label);
    expect(labels.indexOf("Features")).toBe(labels.indexOf("Demos") + 1);
    expect(labels.indexOf("Docs")).toBe(labels.indexOf("Features") + 1);
  });

  it("footer Explore column includes Features", () => {
    const explore = COLUMNS.find((c) => c.heading === "Explore");
    expect(explore?.links.map((l) => l.label)).toContain("Features");
  });
});
