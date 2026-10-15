import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { matchRoutes, type RouteObject } from "react-router";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { classifyPath, NO_TRANSFORM_PREFIXES } from "~/lib/http/cache-policy";
import { PRODUCT_MANIFEST, resolveProductFromPath } from "~/lib/nav/manifest";
import routes from "~/routes";
import { STATIC_PAGES } from "~/routes/files/sitemap";

// J09 (job_3f41461a21e4): the URL reverts of rulings 55 and 56. Foxhound serves
// Recova's paths, so the cutover map is "same path, new domain" (ruling 408
// binding 3). Recova's paths, read in its source:
//   app/(app)/console/page.tsx                    -> /console
//   app/(marketing)/product/{audit,recovery,disputes,intelligence}/page.tsx
//   app/(app)/recovery/dashboard/page.tsx         -> /recovery/dashboard
//   app/(app)/recovery/sequence/page.tsx          -> /recovery/sequence
//   app/(app)/disputes/dashboard/page.tsx         -> /disputes/dashboard
//   app/(app)/intelligence/dashboard/page.tsx     -> /intelligence/dashboard
//   app/admin/platform/{crons,webhooks,audit-log}/page.tsx (admin-nav.ts)
//
// The route tree is matched with React Router's own matchRoutes, the function
// the server uses, so "this URL reaches this page module" is the router's
// answer and not a string comparison.

interface RouteConfigEntry {
  id?: string;
  path?: string;
  index?: boolean;
  file: string;
  children?: RouteConfigEntry[];
}

function toRouteObjects(entries: RouteConfigEntry[]): RouteObject[] {
  return entries.map((e, i) => {
    const base = { id: `${e.file}#${i}`, handle: { file: e.file } };
    if (e.index) return { ...base, index: true, path: e.path } as RouteObject;
    return { ...base, path: e.path, children: e.children ? toRouteObjects(e.children) : undefined } as RouteObject;
  });
}

const ROUTE_OBJECTS = toRouteObjects(routes as unknown as RouteConfigEntry[]);

/** The page module a URL reaches, or null when the router matches nothing. */
function moduleFor(pathname: string): string | null {
  const matches = matchRoutes(ROUTE_OBJECTS, pathname);
  if (!matches || matches.length === 0) return null;
  const leaf = matches[matches.length - 1]!;
  return (leaf.route.handle as { file: string }).file;
}

const NEW_PATHS: Array<[string, string]> = [
  ["/console", "./routes/app/dashboard.tsx"],
  ["/product/audit", "./routes/products/audit.tsx"],
  ["/product/recovery", "./routes/products/recovery.tsx"],
  ["/product/disputes", "./routes/products/disputes.tsx"],
  ["/product/intelligence", "./routes/products/intelligence.tsx"],
  ["/recovery/dashboard", "./routes/app/recovery/index.tsx"],
  ["/recovery/sequence", "./routes/app/recovery/sequences.tsx"],
  ["/disputes/dashboard", "./routes/app/disputes/index.tsx"],
  ["/intelligence/dashboard", "./routes/app/intelligence/index.tsx"],
  ["/admin/platform/crons", "./routes/admin/crons.tsx"],
  ["/admin/platform/webhooks", "./routes/admin/webhooks.tsx"],
  ["/admin/platform/audit-log", "./routes/admin/audit-log.tsx"],
];

// Foxhound's own former paths. None was public (all sit behind sign-in or
// Access) except the four product spokes, which the sitemap published; those
// answer one 301 to their Recova path. Everything else is simply gone, as
// Recova has no page there either (Recova has no /recovery, /disputes or
// /intelligence index page, and D12 and D13 declined the admin orphans with
// "no redirect", ruling 407).
const RETIRED_PATHS = [
  "/dashboard",
  "/recovery",
  "/recovery/sequences",
  "/disputes",
  "/intelligence",
  "/admin/crons",
  "/admin/webhooks",
  "/admin/audit-log",
];

const SITEMAP_PUBLISHED_SPOKES = ["audit", "recovery", "disputes", "intelligence"];

describe("J09: Foxhound serves Recova's paths", () => {
  it("the router walk is live (a known path resolves)", () => {
    expect(moduleFor("/pricing")).toBe("./routes/pricing.tsx");
  });

  for (const [path, file] of NEW_PATHS) {
    it(`${path} reaches ${file}`, () => {
      expect(moduleFor(path)).toBe(file);
    });
  }

  it("/products, Recova's product hub, stays where it is", () => {
    expect(moduleFor("/products")).toBe("./routes/products/index.tsx");
  });

  it("/disputes/:id still reaches the dispute detail page beside /disputes/dashboard", () => {
    expect(moduleFor("/disputes/dp_123")).toBe("./routes/app/disputes/detail.tsx");
  });
});

describe("J09: Foxhound's old paths behave as ruled", () => {
  for (const path of RETIRED_PATHS) {
    it(`${path} reaches no page`, () => {
      expect(moduleFor(path)).toBeNull();
    });
  }

  for (const spoke of SITEMAP_PUBLISHED_SPOKES) {
    it(`/products/${spoke}, published in the sitemap, answers one 301 to /product/${spoke}`, async () => {
      const file = moduleFor(`/products/${spoke}`);
      expect(file, `/products/${spoke} should reach the redirect module`).not.toBeNull();
      const mod = (await import(/* @vite-ignore */ join("../app", file!))) as {
        loader: (args: { request: Request; params: Record<string, string> }) => Response;
      };
      let res: Response | undefined;
      try {
        res = mod.loader({
          request: new Request(`https://foxhoundapp.com/products/${spoke}?ref=x`),
          params: { spoke },
        });
      } catch (thrown) {
        res = thrown as Response;
      }
      expect(res?.status).toBe(301);
      expect(res?.headers.get("Location")).toBe(`/product/${spoke}?ref=x`);
    });
  }

  it("/products/<anything else> is a 404, not a redirect to a page that does not exist", async () => {
    const file = moduleFor("/products/nope");
    expect(file).not.toBeNull();
    const mod = (await import(/* @vite-ignore */ join("../app", file!))) as {
      loader: (args: { request: Request; params: Record<string, string> }) => Response;
    };
    let res: Response | undefined;
    try {
      res = mod.loader({ request: new Request("https://foxhoundapp.com/products/nope"), params: { spoke: "nope" } });
    } catch (thrown) {
      res = thrown as Response;
    }
    expect(res?.status).toBe(404);
  });
});

describe("J09: the nav, the caches and the machine files name the new paths", () => {
  it("the product switcher points at Recova's dashboards", () => {
    expect(PRODUCT_MANIFEST.dashboard.href).toBe("/console");
    expect(PRODUCT_MANIFEST.recovery.href).toBe("/recovery/dashboard");
    expect(PRODUCT_MANIFEST.disputes.href).toBe("/disputes/dashboard");
    expect(PRODUCT_MANIFEST.intelligence.href).toBe("/intelligence/dashboard");
    expect(PRODUCT_MANIFEST.recovery.links.map((l) => l.to)).toContain("/recovery/sequence");
  });

  it("a page under a product still resolves to that product", () => {
    expect(resolveProductFromPath("/console")).toBe("dashboard");
    expect(resolveProductFromPath("/recovery/dashboard")).toBe("recovery");
    expect(resolveProductFromPath("/recovery/payments/fp_1")).toBe("recovery");
    expect(resolveProductFromPath("/disputes/dp_1")).toBe("disputes");
    expect(resolveProductFromPath("/intelligence/customers")).toBe("intelligence");
    expect(resolveProductFromPath("/settings")).toBeNull();
  });

  it("the product spokes are public marketing pages for the cache", () => {
    for (const spoke of SITEMAP_PUBLISHED_SPOKES) {
      expect(classifyPath(`/product/${spoke}`)).toBe("marketing");
    }
  });

  it("the console keeps analytics off, as the dashboard did", () => {
    expect(NO_TRANSFORM_PREFIXES).toContain("/console");
    expect(NO_TRANSFORM_PREFIXES).not.toContain("/dashboard");
  });

  it("the sitemap lists /product/* and no /products/<spoke>", () => {
    const paths = STATIC_PAGES.map((p) => p.path);
    for (const spoke of SITEMAP_PUBLISHED_SPOKES) {
      expect(paths).toContain(`/product/${spoke}`);
      expect(paths).not.toContain(`/products/${spoke}`);
    }
  });
});

// ---------------------------------------------------------------------------
// No internal link names an old path.
//
// Every string literal and template-literal part in the shipped source (app/,
// workers/, mcp/src/) is read with TypeScript's own scanner, so comments, which
// carry history and legacy citations, are not counted, and a path assembled in
// a template (`${base}/dashboard`) is. The one file allowed to name an old path
// is the redirect module that retires it.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCANNED_DIRS = ["app", "workers", "mcp/src"];
const ALLOWED_FILES = new Set(["app/routes/products/spoke-redirect.ts"]);

// A path segment boundary: the old path must not be the tail of a longer path
// ("/demos/dashboard", "/recovery/dashboard") or of a module specifier
// ("./routes/admin/crons.tsx", "~/lib/admin/crons").
const B = String.raw`(?:^|[^\w/.~-])`;
const OLD_PATH_PATTERNS: RegExp[] = [
  new RegExp(`${B}/dashboard(?![\\w-])`),
  new RegExp(`${B}/products/(?:audit|recovery|disputes|intelligence)(?![\\w-])`),
  new RegExp(`${B}/recovery/sequences(?![\\w-])`),
  new RegExp(`${B}/admin/(?:crons|webhooks|audit-log)(?![\\w-])`),
  // The bare product indexes. "/disputes/" + id is the detail page and stays.
  new RegExp(`${B}/(?:recovery|disputes|intelligence)(?=$|[?#])`),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "+types") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function stringParts(source: string, isTsx: boolean): string[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    isTsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    source,
  );
  const parts: string[] = [];
  let braceDepth: number[] = [];
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    switch (token) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
        parts.push(scanner.getTokenValue());
        if (token === ts.SyntaxKind.TemplateHead) braceDepth.push(0);
        break;
      case ts.SyntaxKind.OpenBraceToken:
        if (braceDepth.length) braceDepth[braceDepth.length - 1]!++;
        break;
      case ts.SyntaxKind.CloseBraceToken:
        if (braceDepth.length && braceDepth[braceDepth.length - 1] === 0) {
          token = scanner.reScanTemplateToken(false);
          parts.push(scanner.getTokenValue());
          if (token === ts.SyntaxKind.TemplateTail) braceDepth.pop();
        } else if (braceDepth.length) {
          braceDepth[braceDepth.length - 1]!--;
        }
        break;
      default:
        break;
    }
    token = scanner.scan();
  }
  braceDepth = [];
  return parts;
}

function offendersIn(text: string): string[] {
  return OLD_PATH_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

describe("J09: no internal link names an old path", () => {
  it("the scanner reads string literals and template parts, not comments (control)", () => {
    const sample = [
      "// a comment naming /dashboard is history, not a link",
      'const a = "/dashboard";',
      "const b = `${base}/products/recovery?x=1`;",
      'const c = "./routes/admin/crons.tsx";',
      'const d = "/demos/dashboard";',
      'const e = `/disputes/${id}`;',
      'const f = "/recovery";',
    ].join("\n");
    const hits = stringParts(sample, false).filter((p) => offendersIn(p).length > 0);
    expect(hits).toEqual(["/dashboard", "/products/recovery?x=1", "/recovery"]);
  });

  it("no shipped source file names an old Foxhound path", () => {
    const files = SCANNED_DIRS.flatMap((d) => walk(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (ALLOWED_FILES.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      for (const part of stringParts(source, file.endsWith("x"))) {
        if (offendersIn(part).length > 0) found.push(`${rel}: ${JSON.stringify(part.slice(0, 120))}`);
      }
    }
    expect(found, `old paths named in source:\n${found.join("\n")}`).toEqual([]);
  });
});
