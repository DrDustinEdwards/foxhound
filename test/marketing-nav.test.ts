import { describe, expect, it } from "vitest";

import { NAV_LINKS } from "~/components/header";
import { COLUMNS } from "~/components/footer";
import { MARKETING_PILL_ITEMS } from "~/lib/nav/manifest";
import routes from "~/routes";

// Every header/footer/pill href resolves in the real route tree.

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

// Wordmark home link and the auth-state CTAs.
const HEADER_STATIC_LINKS = ["/", "/login", "/audit", "/console"];

describe("marketing header + footer links match routes.ts", () => {
  const realPaths = new Set<string>();
  collectPaths(routes as unknown as RouteConfigEntry[], "", realPaths);

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
        expect(
          realPaths.has(link.to),
          `${link.to} (footer: ${column.heading}) is not in routes.ts`,
        ).toBe(true);
      }
    }
  });

  it("every section-pill item is a real route", () => {
    for (const item of MARKETING_PILL_ITEMS) {
      expect(
        realPaths.has(item.to),
        `${item.to} (section pill: ${item.label}) is not in routes.ts`,
      ).toBe(true);
    }
  });
});
