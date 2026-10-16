import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { blogPosts } from "~/db";
import type { Db } from "~/db";
import routes from "~/routes";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J61 (job_2ee0cfdd5c29), rows F1, F2, F3, F4, F5, M15 and M16: the
// machine-readable SET. Recova's spec, read whole at HEAD: app/sitemap.ts
// (9c80793c), app/(marketing)/blog/sitemap.ts (cb2cfa71), app/robots.ts
// (b5a07e27), app/llms.txt/route.ts (784d7ac6), app/llms-full.txt/route.ts
// (ad298fd6), app/feed.rss/route.ts (bdc2071c),
// app/(marketing)/blog/rss.xml/route.ts (7964bcbf) and lib/blog.ts (55a92d1a).
//
// Every assertion reads a RESPONSE BODY a loader returned over a real
// in-memory D1 schema, so a builder that is never wired to its route cannot
// pass. Each parse is checked non-empty before anything is believed of it
// (RULES.md 6.2: a check over an empty list proves nothing).

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
vi.mock("~/lib/cloudflare-context", () => ({
  cloudflareContext: Symbol("cloudflare") as unknown,
}));

const sitemap = await import("~/routes/files/sitemap");
const feed = await import("~/routes/files/feed");
const llms = await import("~/routes/files/llms");
const llmsFull = await import("~/routes/files/llms-full");
const robots = await import("~/routes/files/robots");

const ORIGIN = "https://example.com";
const context = { get: () => ({ env: { DB: {}, BETTER_AUTH_URL: ORIGIN } }) };

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 8, 30, 12);

function seed(
  db: Db,
  slug: string,
  opts: { tags?: string[]; published?: boolean; publishedDaysAgo?: number | null; updatedDaysAgo?: number; title?: string },
) {
  const publishedAt =
    opts.publishedDaysAgo === null ? null : new Date(BASE - (opts.publishedDaysAgo ?? 0) * DAY);
  const updatedAt = new Date(BASE - (opts.updatedDaysAgo ?? opts.publishedDaysAgo ?? 0) * DAY);
  return db.insert(blogPosts).values({
    id: slug,
    slug,
    title: opts.title ?? `Title of ${slug}`,
    excerpt: `Excerpt of ${slug}.`,
    body: "word ".repeat(50),
    published: opts.published ?? true,
    publishedAt,
    createdAt: updatedAt,
    updatedAt,
    author: "Foxhound",
    tags: opts.tags ?? [],
    featured: false,
    readingMinutes: 1,
  });
}

/** The published fixture: four live posts, one draft. */
async function seededDb(): Promise<Db> {
  const { db } = createInMemoryDb();
  await seed(db, "oldest-recovery", { tags: ["payment-recovery", "subscription-intelligence"], publishedDaysAgo: 30, updatedDaysAgo: 2 });
  await seed(db, "decline-guide", { tags: ["decline-codes", "disputes"], publishedDaysAgo: 20 });
  await seed(db, "brackets-and-amps", {
    tags: ["comparisons"],
    publishedDaysAgo: 10,
    title: "Foxhound & friends [2026]",
  });
  await seed(db, "undated", { tags: ["payment-recovery"], publishedDaysAgo: null, updatedDaysAgo: 5 });
  await seed(db, "a-draft", { tags: ["saas-metrics"], published: false, publishedDaysAgo: 1 });
  return db;
}

const PUBLISHED = ["oldest-recovery", "decline-guide", "brackets-and-amps", "undated"].sort();

type Loader = (args: never) => Promise<Response> | Response;

async function get(loader: unknown, path: string): Promise<{ status: number; type: string; body: string }> {
  const request = new Request(`${ORIGIN}${path}`);
  const res = await (loader as Loader)({ request, context } as never);
  return { status: res.status, type: res.headers.get("Content-Type") ?? "", body: await res.text() };
}

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
const urlBlocks = (xml: string) => xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
const items = (xml: string) => xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
const itemLink = (item: string) => item.match(/<link>([^<]+)<\/link>/)?.[1] ?? "";

/** /blog/<slug> URLs only: not the index, the archive or a tag archive. */
function postSlugs(urls: string[]): string[] {
  return urls
    .map((u) => u.replace(ORIGIN, ""))
    .filter((p) => /^\/blog\/[^/]+$/.test(p) && p !== "/blog/archive" && !p.endsWith(".xml"))
    .map((p) => p.slice("/blog/".length));
}

/** Every post link in a Markdown llms file. */
function llmsPostSlugs(text: string): string[] {
  const urls = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]!);
  return postSlugs(urls);
}

describe("J61: every machine-readable file lists the same published post set", () => {
  it("the fixture is non-empty and carries a draft that must stay out", async () => {
    harness.db = await seededDb();
    const blog = await get(sitemap.loader, "/blog/sitemap.xml");
    expect(blog.status).toBe(200);
    expect(locs(blog.body).length, "the blog sitemap parsed to nothing").toBeGreaterThan(0);
  });

  it("the blog sitemap, both feeds and both llms files name exactly the published posts", async () => {
    harness.db = await seededDb();
    const blogSitemap = await get(sitemap.loader, "/blog/sitemap.xml");
    const feedRss = await get(feed.loader, "/feed.rss");
    const blogRss = await get(feed.loader, "/blog/rss.xml");
    const short = await get(llms.loader, "/llms.txt");
    const full = await get(llmsFull.loader, "/llms-full.txt");

    const sets: Record<string, string[]> = {
      "/blog/sitemap.xml": postSlugs(locs(blogSitemap.body)),
      "/feed.rss": postSlugs(items(feedRss.body).map(itemLink)),
      "/blog/rss.xml": postSlugs(items(blogRss.body).map(itemLink)),
      "/llms.txt": [...new Set(llmsPostSlugs(short.body))],
      "/llms-full.txt": llmsPostSlugs(full.body),
    };
    for (const [file, slugs] of Object.entries(sets)) {
      expect(slugs.length, `${file} parsed no posts`).toBeGreaterThan(0);
      expect([...slugs].sort(), file).toEqual(PUBLISHED);
    }
  });

  it("llms-full.txt lists each post exactly once, and says how many", async () => {
    harness.db = await seededDb();
    const full = (await get(llmsFull.loader, "/llms-full.txt")).body;
    const slugs = llmsPostSlugs(full);
    expect(slugs.length).toBe(new Set(slugs).size);
    expect(full).toContain(`complete article index (${PUBLISHED.length} articles)`);
  });

  it("each post is in exactly one sitemap: the blog sitemap, not the root (Recova app/sitemap.ts)", async () => {
    harness.db = await seededDb();
    const root = await get(sitemap.loader, "/sitemap.xml");
    expect(locs(root.body).length).toBeGreaterThan(20);
    expect(postSlugs(locs(root.body))).toEqual([]);
  });

  it("the root sitemap is a flat urlset, never the sitemap index Recova tried and reverted", async () => {
    harness.db = await seededDb();
    for (const path of ["/sitemap.xml", "/blog/sitemap.xml"]) {
      const res = await get(sitemap.loader, path);
      expect(res.type).toContain("application/xml");
      expect(res.body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      expect(res.body).not.toContain("<sitemapindex");
    }
  });
});

describe("J61: no invented dates", () => {
  it("no static entry in the root sitemap carries a lastmod (ruling 39 class, ROWS-F F1)", async () => {
    harness.db = await seededDb();
    const root = (await get(sitemap.loader, "/sitemap.xml")).body;
    const blocks = urlBlocks(root);
    expect(blocks.length).toBeGreaterThan(20);
    const dated = blocks.filter((b) => b.includes("<lastmod>"));
    expect(dated, "a static entry claims a modification date").toEqual([]);
  });

  it("each blog sitemap entry's lastmod is the post's own updated date, never the request clock", async () => {
    harness.db = await seededDb();
    const blocks = urlBlocks((await get(sitemap.loader, "/blog/sitemap.xml")).body);
    expect(blocks.length).toBe(PUBLISHED.length);
    const lastmod = (slug: string) =>
      blocks.find((b) => b.includes(`/blog/${slug}</loc>`))?.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    expect(lastmod("oldest-recovery")).toBe(new Date(BASE - 2 * DAY).toISOString());
    expect(lastmod("decline-guide")).toBe(new Date(BASE - 20 * DAY).toISOString());
    expect(lastmod("undated")).toBe(new Date(BASE - 5 * DAY).toISOString());
    for (const b of blocks) {
      expect(b).toContain("<changefreq>monthly</changefreq>");
      expect(b).toContain("<priority>0.7</priority>");
    }
  });

  it("both feeds date the channel by the newest post and leave an undated post undated", async () => {
    harness.db = await seededDb();
    for (const path of ["/feed.rss", "/blog/rss.xml"]) {
      const body = (await get(feed.loader, path)).body;
      expect(body.match(/<lastBuildDate>([^<]+)<\/lastBuildDate>/)?.[1], path).toBe(
        new Date(BASE - 10 * DAY).toUTCString(),
      );
      const undated = items(body).find((i) => itemLink(i).endsWith("/blog/undated"));
      expect(undated, `${path} lost the undated post`).toBeDefined();
      expect(undated, path).not.toContain("<pubDate>");
    }
  });

  it("neither llms file carries a hand-typed Updated date", async () => {
    harness.db = await seededDb();
    for (const [loader, path] of [
      [llms.loader, "/llms.txt"],
      [llmsFull.loader, "/llms-full.txt"],
    ] as const) {
      expect((await get(loader, path)).body, path).not.toMatch(/^Updated:/m);
    }
  });
});

describe("J61: the two feeds are Recova's two feeds", () => {
  it("/blog/rss.xml is registered in app/routes.ts beside /feed.rss, from the same module", () => {
    const flat: Array<{ path?: string; file?: string }> = [];
    const walk = (entries: Array<{ path?: string; file?: string; children?: unknown[] }>) => {
      for (const e of entries) {
        flat.push(e);
        if (e.children) walk(e.children as never);
      }
    };
    walk(routes as never);
    const fileOf = (path: string) => flat.find((e) => e.path === path)?.file;
    expect(fileOf("feed.rss")).toBe("./routes/files/feed.ts");
    expect(fileOf("blog/rss.xml")).toBe("./routes/files/feed.ts");
    expect(fileOf("sitemap.xml")).toBe("./routes/files/sitemap.ts");
    expect(fileOf("blog/sitemap.xml")).toBe("./routes/files/sitemap.ts");
  });

  it("each feed points its self link at itself, carries Recova's headers, and escapes a title", async () => {
    harness.db = await seededDb();
    for (const path of ["/feed.rss", "/blog/rss.xml"]) {
      const res = await get(feed.loader, path);
      expect(res.status).toBe(200);
      expect(res.type).toBe("application/rss+xml; charset=utf-8");
      expect(res.body).toContain(`<atom:link href="${ORIGIN}${path}" rel="self" type="application/rss+xml"`);
      expect(res.body).toContain("<title>Foxhound &amp; friends [2026]</title>");
      expect(items(res.body).length).toBe(PUBLISHED.length);
    }
  });

  it("/feed.rss keeps Recova's channel image and per-item author; /blog/rss.xml carries neither, as Recova's does not", async () => {
    harness.db = await seededDb();
    const root = (await get(feed.loader, "/feed.rss")).body;
    const blog = (await get(feed.loader, "/blog/rss.xml")).body;
    expect(root).toContain(`<url>${ORIGIN}/favicon.png</url>`);
    for (const i of items(root)) expect(i).toContain("<author>support@foxhoundapp.com (Foxhound)</author>");
    expect(blog).not.toContain("<image>");
    expect(blog).not.toContain("<author>");
  });

  it("the items come from Prelum's rssItem, so a category is escaped and the body is not shipped empty", async () => {
    harness.db = await seededDb();
    const body = (await get(feed.loader, "/blog/rss.xml")).body;
    expect(body).toContain("xmlns:content=");
    expect(body).toContain("<category>decline-codes</category>");
    expect(body).not.toContain("<content:encoded></content:encoded>");
  });
});

describe("J61: the llms pair follows Recova's shape on Foxhound's facts", () => {
  it("llms.txt lists Recova's key pages, Features and All articles included", async () => {
    harness.db = await seededDb();
    const body = (await get(llms.loader, "/llms.txt")).body;
    for (const [title, path] of [
      ["Homepage", ""],
      ["Products overview", "/products"],
      ["Pricing", "/pricing"],
      ["Features", "/features"],
      ["Demos", "/demos"],
      ["Docs", "/docs"],
      ["Free audit", "/audit"],
      ["Blog", "/blog"],
      ["All articles", "/blog/archive"],
    ]) {
      expect(body).toContain(`- [${title}](${ORIGIN}${path})`);
    }
  });

  it("llms.txt groups posts by topic, in Recova's topic order, with a computed count", async () => {
    harness.db = await seededDb();
    const body = (await get(llms.loader, "/llms.txt")).body;
    const headings = [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Payment Recovery (2 articles)",
      "Decline Codes (1 article)",
      "Dispute Handling (1 article)",
      "Subscription Intelligence (1 article)",
      "Comparisons (1 article)",
    ]);
    // A topic only a draft carries is not advertised.
    expect(body).not.toContain("SaaS Metrics");
    // Prelum escapes a bracket in link text; the ampersand stays prose.
    expect(body).toContain(`- [Foxhound & friends \\[2026\\]](${ORIGIN}/blog/brackets-and-amps)`);
  });

  it("llms-full.txt drops the sentence that said articles are not enumerated, now that they are", async () => {
    harness.db = await seededDb();
    const body = (await get(llmsFull.loader, "/llms-full.txt")).body;
    expect(body).not.toContain("Individual article titles and URLs are not enumerated here");
    expect(body).toContain(`Blog archive: ${ORIGIN}/blog/archive`);
  });

  it("the Recova-named parts never ship: no Recova string, no recovamrr.com", async () => {
    harness.db = await seededDb();
    const bodies = [
      (await get(llms.loader, "/llms.txt")).body,
      (await get(llmsFull.loader, "/llms-full.txt")).body,
      (await get(feed.loader, "/feed.rss")).body,
      (await get(feed.loader, "/blog/rss.xml")).body,
      (await get(sitemap.loader, "/sitemap.xml")).body,
      (await get(sitemap.loader, "/blog/sitemap.xml")).body,
    ];
    for (const b of bodies) {
      expect(b.length).toBeGreaterThan(0);
      expect(b).not.toMatch(/recova/i);
    }
  });
});

describe("J61: robots.txt matches Recova where Recova was right (F2, RULES.md 2.6)", () => {
  const rendered = robots.buildRobotsTxt(ORIGIN);
  const wildcard = rendered.split("\n\n")[0]!.split("\n");

  it("Recova's sign-in pages and the audit's connect and callback stay crawlable, as on Recova", () => {
    expect(wildcard.length).toBeGreaterThan(10);
    for (const path of ["/login", "/signup", "/forgot-password", "/reset-password", "/audit/connect", "/audit/callback"]) {
      expect(wildcard, `${path} is disallowed; Recova's app/robots.ts allows it`).not.toContain(`Disallow: ${path}`);
    }
  });

  it("every path Recova disallows that Foxhound serves is still disallowed", () => {
    // Recova's list, verbatim from app/robots.ts. /oauth/ has no Foxhound
    // route (it rides rows F18 and F19), so it is checked separately below.
    const recova = [
      "/console", "/settings", "/billing", "/admin", "/help", "/connect", "/welcome", "/invite",
      "/audit/dashboard", "/audit/results/", "/recovery/dashboard", "/recovery/payments",
      "/recovery/sequence", "/disputes/dashboard", "/disputes/", "/intelligence/", "/api/", "/auth/",
    ];
    const disallowed = wildcard.filter((l) => l.startsWith("Disallow: ")).map((l) => l.slice(10));
    for (const path of recova) {
      expect(disallowed.some((d) => path.startsWith(d)), `${path} is crawlable`).toBe(true);
    }
  });

  it("names only the root sitemap, as Recova's robots.txt does", () => {
    const sitemaps = rendered.split("\n").filter((l) => l.startsWith("Sitemap:"));
    expect(sitemaps).toEqual([`Sitemap: ${ORIGIN}/sitemap.xml`]);
  });
});

describe("J61: built through Prelum (Q2)", () => {
  it("the sitemap, the feeds and the llms pair import Prelum's helpers", () => {
    const uses: Array<[string, string]> = [
      ["app/routes/files/sitemap.ts", "sitemapDocument"],
      ["app/routes/files/feed.ts", "rssItem"],
      ["app/routes/files/llms.ts", "llmsDocument"],
      ["app/routes/files/llms-full.ts", "llmsDocument"],
    ];
    for (const [file, name] of uses) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "@drdustinedwards/site-helpers/`));
    }
  });

  it("is pinned to the tag the job names", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@drdustinedwards/site-helpers"]).toBe("github:DrDustinEdwards/prelum#v0.2.0");
  });
});

describe("J61: the pages and the files read one topic set", () => {
  it("getPublishedTagSet (archive pills, tag gate) equals the topic set the files are built from", async () => {
    const db = await seededDb();
    const { getPublishedTagSet } = await import("~/lib/blog/queries.server");
    const { loadPublishedSet } = await import("~/lib/blog/published-set.server");
    const pages = await getPublishedTagSet(db);
    const files = (await loadPublishedSet(db)).tags;
    expect(pages.length).toBeGreaterThan(0);
    expect([...pages].sort()).toEqual([...files].sort());
    expect(pages).not.toContain("saas-metrics");
  });
});
