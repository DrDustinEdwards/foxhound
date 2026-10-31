import { createSiteApi } from "@dustinedwards/site-api";
import { runConformance } from "@dustinedwards/site-api/conformance";
import { d1ScheduledUpdates } from "@dustinedwards/site-api/schedules";
import { describe, expect, it } from "vitest";

import { getPostBySlug } from "~/lib/blog/queries.server";
import { carrelAdapter } from "~/lib/carrel/adapter.server";
import { handleCarrelRequest } from "~/lib/carrel/handler.server";
import { parsePostSource, serializePostSource } from "~/lib/carrel/source";

import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

const KEY = "k".repeat(40);
const ORIGIN = "https://foxhoundapp.com";
const BASE = `${ORIGIN}/api/carrel/v1`;
/** The handler takes the request's ExecutionContext. */
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function setup(limit = () => true) {
  const { db, sqlite } = createInMemoryDb();
  let adapterCalls = 0;
  const adapter = carrelAdapter(db, d1ScheduledUpdates(d1Over(sqlite)));
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
});

describe("the planted refusals (adapter must never run)", () => {

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
        CTX,
      );
      expect(response).toBeNull();
    },
  );

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

  it("a slug change is refused; media answers 501", async () => {
    const t = setup();
    await t.call("/content/p2/draft", {
      method: "PUT",
      body: JSON.stringify({ source: SOURCE, expectedVersion: null, changeId: "c1" }),
    });
    const doc = (await (await t.call("/content/p2")).json()) as { version: string };
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

  it("a draft with no title previews as Untitled, noindex; a save of it is refused", async () => {
    const t = setup();
    const preview = await t.call("/preview", { method: "POST", body: JSON.stringify({ source: "# A heading only\n" }) });
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("<title>Untitled</title>");
    expect(html).toContain('content="noindex"');
    const saved = await t.call("/content/p3/draft", {
      method: "PUT",
      body: JSON.stringify({ source: "# A heading only\n", expectedVersion: null, changeId: "c4" }),
    });
    expect(saved.status).toBe(422);
  });

  it("a scheduled post goes live on the cron at its time, and a scheduled update leaves the live post served until then", async () => {
    const t = setup();
    const json = async (r: Response) => (await r.json()) as { version: string; status: string; publishAt: string | null };
    const draft = await json(
      await t.call("/content/s1/draft", { method: "PUT", body: JSON.stringify({ source: SOURCE, expectedVersion: null, changeId: "c1" }) }),
    );
    const at = "2030-01-01T15:00:00.000Z";
    const scheduled = await json(
      await t.call("/content/s1/schedule", {
        method: "POST",
        body: JSON.stringify({ expectedVersion: draft.version, changeId: "c2", publishAt: "2030-01-01T09:00:00-06:00" }),
      }),
    );
    expect(scheduled.status).toBe("scheduled");
    expect((await json(await t.call("/content/s1"))).publishAt).toBe(at);
    const listed = (await (await t.call("/content?status=scheduled")).json()) as { items: Array<{ id: string }> };
    expect(listed.items.map((i) => i.id)).toEqual(["s1"]);

    // A minute early: nothing is due, and the post is not on the blog.
    expect((await t.api.runSchedules({ now: new Date("2030-01-01T14:59:00Z") })).applied).toEqual([]);
    expect(await getPostBySlug(t.db, "why-cards-fail")).toBeNull();

    // The cron at its time puts it live, dated the time it was scheduled for.
    const run = await t.api.runSchedules({ now: new Date("2030-01-01T15:00:30Z") });
    expect(run.applied.map((a) => [a.id, a.kind])).toEqual([["s1", "publish"]]);
    const live = await getPostBySlug(t.db, "why-cards-fail");
    expect(live?.publishedAt?.toISOString()).toBe(at);
    expect((await t.api.runSchedules({ now: new Date("2030-01-01T15:01:00Z") })).applied).toEqual([]);

    // An update scheduled on the live post: the live version stays served.
    const current = await json(await t.call("/content/s1"));
    expect(current.status).toBe("published");
    const update = await t.call("/content/s1/schedule", {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: current.version,
        changeId: "c3",
        publishAt: "2030-02-01T00:00:00Z",
        source: SOURCE.replace("Hello", "Goodbye"),
      }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ status: "published", scheduledUpdate: { changeId: "c3" } });
    expect((await getPostBySlug(t.db, "why-cards-fail"))?.body).toContain("Hello");

    await t.api.runSchedules({ now: new Date("2030-02-01T00:00:00Z") });
    const updated = await getPostBySlug(t.db, "why-cards-fail");
    expect(updated?.body).toContain("Goodbye");
    expect(updated?.publishedAt?.toISOString()).toBe(at);
    expect((await t.call("/content/s1/schedule")).status).toBe(404);
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
