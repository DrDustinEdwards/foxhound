import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { createSiteApi } from "@dustinedwards/site-api";
import { runConformance } from "@dustinedwards/site-api/conformance";
import { describe, expect, it } from "vitest";

import { carrelAdapter } from "~/lib/carrel/adapter.server";
import { handleCarrelRequest } from "~/lib/carrel/handler.server";
import { parsePostSource, serializePostSource, SourceError } from "~/lib/carrel/source";

import { createInMemoryDb } from "./helpers/inmemory-db";

const KEY = "k".repeat(40);
const ORIGIN = "https://foxhoundapp.com";
const BASE = `${ORIGIN}/api/carrel/v1`;

function setup(limit = () => true) {
  const { db, sqlite } = createInMemoryDb();
  let adapterCalls = 0;
  const adapter = carrelAdapter(db);
  const counted = new Proxy(adapter.content, {
    get(target, prop, receiver) {
      adapterCalls++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const api = createSiteApi({
    adapter: { ...adapter, content: counted },
    key: KEY,
    limiter: { limit: async () => ({ success: limit() }) },
    log: () => {},
  });
  const call = (path: string, init: RequestInit = {}, key: string | null = KEY) =>
    api.handle(
      new Request(`${BASE}${path}`, {
        ...init,
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      }),
    );
  return { db, sqlite, api, call, calls: () => adapterCalls };
}

const SOURCE = serializePostSource({
  title: "Why cards fail",
  slug: "why-cards-fail",
  excerpt: "Reasons.",
  author: "Foxhound",
  tags: ["billing"],
  featured: false,
  body: "Hello **world**.\n",
});

describe("source round trip", () => {
  it("is lossless", () => {
    const parsed = parsePostSource(SOURCE, { author: "x" });
    expect(parsed.title).toBe("Why cards fail");
    expect(parsed.tags).toEqual(["billing"]);
    expect(serializePostSource(parsed)).toBe(SOURCE);
  });

  it("refuses a source without front matter or a title", () => {
    expect(() => parsePostSource("no front matter", { author: "x" })).toThrow(SourceError);
    expect(() => parsePostSource('---\nexcerpt: "x"\n---\nbody', { author: "x" })).toThrow(/title/);
  });
});

describe("the planted refusals (adapter must never run)", () => {
  it("no key and a wrong key are refused", async () => {
    const t = setup();
    expect((await t.call("/content", {}, null)).status).toBe(401);
    expect((await t.call("/content", {}, "w".repeat(40))).status).toBe(401);
    expect(t.calls()).toBe(0);
  });

  it("a short site key refuses everything", async () => {
    const { db } = createInMemoryDb();
    const api = createSiteApi({
      adapter: carrelAdapter(db),
      key: "short",
      limiter: { limit: async () => ({ success: true }) },
      log: () => {},
    });
    const res = await api.handle(new Request(`${BASE}/meta`, { headers: { authorization: "Bearer short" } }));
    expect(res.status).not.toBe(200);
  });

  it("an unknown route is refused", async () => {
    const t = setup();
    expect((await t.call("/nope")).status).toBeGreaterThanOrEqual(400);
    expect(t.calls()).toBe(0);
  });

  it("a rate-limited caller is refused before the key is checked", async () => {
    const t = setup(() => false);
    expect((await t.call("/content")).status).toBe(429);
    expect(t.calls()).toBe(0);
  });

  it("a stale expectedVersion is refused with the current version", async () => {
    const t = setup();
    const created = await t.call("/content/post-1/draft", {
      method: "PUT",
      body: JSON.stringify({ source: SOURCE, expectedVersion: null, changeId: "chg-1" }),
    });
    expect(created.status).toBe(200);
    const { version } = (await created.json()) as { version: string };
    const stale = await t.call("/content/post-1/draft", {
      method: "PUT",
      body: JSON.stringify({ source: SOURCE, expectedVersion: "1", changeId: "chg-2" }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { currentVersion: string }).currentVersion).toBe(version);
  });
});

describe("the key reaches only the prefix", () => {
  it.each(["/admin", "/admin/blog", "/dashboard", "/billing", "/webhooks/stripe", "/api/auth/session", "/mcp"])(
    "%s is never served by the Carrel handler, even with the key",
    async (path) => {
      const response = await handleCarrelRequest(
        new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${KEY}` } }),
        { DB: {}, CARREL_SITE_KEY: KEY } as unknown as Env,
      );
      expect(response).toBeNull();
    },
  );

  it("the mounted handler takes its key from env, through the repo's own limiter", async () => {
    const stub = { check: async () => ({ allowed: true, retryAfterSec: 0 }) };
    const env = {
      DB: {},
      CARREL_SITE_KEY: KEY,
      RATE_LIMITER: { idFromName: (n: string) => n, get: () => stub },
    } as unknown as Env;
    const ask = (key: string) =>
      handleCarrelRequest(new Request(`${BASE}/meta`, { headers: { authorization: `Bearer ${key}` } }), env);
    expect((await ask(KEY))?.status).toBe(200);
    expect((await ask("x".repeat(40)))?.status).toBe(401);
  });

  it("CARREL_SITE_KEY appears in exactly one source module (env.d.ts is the root type file)", () => {
    const found = execSync("git grep --untracked -l CARREL_SITE_KEY -- app workers || true", { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    expect(found).toEqual(["app/lib/carrel/handler.server.ts"]);
  });

  it("the worker mounts the handler before the router, behind the prefix check", () => {
    const source = readFileSync("workers/app.ts", "utf8");
    expect(source).toContain('pathname.startsWith("/api/carrel/v1")');
    expect(source.indexOf("handleCarrelRequest")).toBeLessThan(source.indexOf("requestHandler(request, context)"));
  });
});

describe("content round trip against the real schema", () => {
  it("create, read, edit, publish, unpublish, revisions", async () => {
    const t = setup();
    const put = (id: string, body: unknown) =>
      t.call(`/content/${id}/draft`, { method: "PUT", body: JSON.stringify(body) });

    const created = (await (await put("p1", { source: SOURCE, expectedVersion: null, changeId: "c1" })).json()) as {
      version: string;
      status: string;
    };
    expect(created.status).toBe("draft");

    // create over an existing id is a conflict
    expect((await put("p1", { source: SOURCE, expectedVersion: null, changeId: "c1b" })).status).toBe(409);

    const doc = (await (await t.call("/content/p1")).json()) as { source: string; version: string; path: string | null };
    expect(doc.source).toBe(SOURCE);
    expect(doc.path).toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    const edited = SOURCE.replace("Hello", "Goodbye");
    const saved = (await (await put("p1", { source: edited, expectedVersion: doc.version, changeId: "c2" })).json()) as {
      version: string;
    };
    expect(saved.version).not.toBe(doc.version);

    // the pre-edit state is a revision, stamped with the Carrel change id
    const revs = (await (await t.call("/content/p1/revisions")).json()) as {
      items: Array<{ version: string; author: string }>;
    };
    expect(revs.items).toHaveLength(2);
    expect(revs.items[1].author).toBe("carrel:c2");
    const diff = (await (await t.call(`/content/p1/diff?from=${revs.items[1].version}`)).json()) as { patch: string };
    expect(diff.patch).toContain("-Hello");
    expect(diff.patch).toContain("+Goodbye");

    await new Promise((r) => setTimeout(r, 5));
    const pub = await t.call("/content/p1/publish", {
      method: "POST",
      body: JSON.stringify({ expectedVersion: saved.version, changeId: "c3" }),
    });
    expect(pub.status).toBe(200);
    const published = (await pub.json()) as { status: string; version: string };
    expect(published.status).toBe("published");
    const live = (await (await t.call("/content/p1")).json()) as { path: string };
    expect(live.path).toBe("/blog/why-cards-fail");

    await new Promise((r) => setTimeout(r, 5));
    const un = (await (
      await t.call("/content/p1/unpublish", {
        method: "POST",
        body: JSON.stringify({ expectedVersion: published.version, changeId: "c4" }),
      })
    ).json()) as { status: string };
    expect(un.status).toBe("draft");

    const list = (await (await t.call("/content?status=draft")).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
  });

  it("scheduling and a slug change are refused; media answers 501", async () => {
    const t = setup();
    await t.call("/content/p2/draft", {
      method: "PUT",
      body: JSON.stringify({ source: SOURCE, expectedVersion: null, changeId: "c1" }),
    });
    const doc = (await (await t.call("/content/p2")).json()) as { version: string };
    const schedule = await t.call("/content/p2/schedule", {
      method: "POST",
      body: JSON.stringify({ expectedVersion: doc.version, changeId: "c2", publishAt: "2030-01-01T00:00:00Z" }),
    });
    expect(schedule.status).toBe(422);
    const renamed = await t.call("/content/p2/draft", {
      method: "PUT",
      body: JSON.stringify({
        source: SOURCE.replace("why-cards-fail", "other"),
        expectedVersion: doc.version,
        changeId: "c3",
      }),
    });
    expect(renamed.status).toBe(422);
    expect((await t.call("/media")).status).toBe(501);
  });

  it("the package's own conformance suite passes against the adapter", async () => {
    const t = setup();
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        t.api.handle(new Request(input as string, init))) as typeof fetch,
    });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
  });
});
