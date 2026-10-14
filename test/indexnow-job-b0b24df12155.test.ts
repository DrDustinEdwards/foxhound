import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { classifyPath } from "~/lib/http/cache-policy";
import { serializePostSource } from "~/lib/carrel/source";

import { createInMemoryDb } from "./helpers/inmemory-db";

// IndexNow (job_b0b24df12155, row F20). Recova is the spec: it publishes a key
// file at /<key>.txt and, on every save that leaves a blog post published, POSTs
// that post's one URL to api.indexnow.org without waiting and without ever
// failing the save. Foxhound does the same with its OWN key (Dustin, Q15,
// 2026-10-14, "new key"): never Recova's key, never its filename.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { INDEXNOW_KEY, INDEXNOW_KEY_PATH } = await import("~/lib/seo/indexnow-key");
const indexNow = await import("~/lib/seo/indexnow.server");
const keyRoute = await import("~/routes/files/indexnow-key");
const { handleCarrelRequest } = await import("~/lib/carrel/handler.server");
const adminDetail = await import("~/routes/admin/blog/detail");
const { createPost, getPostForAdmin } = await import("~/lib/blog/admin-queries.server");
const routes = (await import("~/routes")).default;

const ORIGIN = "https://foxhoundapp.com";
const SITE_KEY = "k".repeat(40);
const ENDPOINT = "https://api.indexnow.org/indexnow";

type Captured = { url: string; body: { host: string; key: string; keyLocation: string; urlList: string[] } };

let captured: Captured[];
let pending: Promise<unknown>[];
let fetchImpl: () => Promise<Response>;

beforeEach(() => {
  captured = [];
  pending = [];
  fetchImpl = async () => new Response(null, { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return fetchImpl();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function envFor(siteOrigin = ORIGIN): Env {
  const stub = { check: async () => ({ allowed: true, retryAfterSec: 0 }) };
  return {
    DB: {},
    CARREL_SITE_KEY: SITE_KEY,
    BETTER_AUTH_URL: siteOrigin,
    RATE_LIMITER: { idFromName: (n: string) => n, get: () => stub },
  } as unknown as Env;
}

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** Wait for every scheduled submission, and prove none of them rejects. */
async function settled() {
  const results = await Promise.allSettled(pending);
  for (const r of results) expect(r.status).toBe("fulfilled");
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

function carrel(path: string, body: unknown, env = envFor()) {
  return handleCarrelRequest(
    new Request(`${ORIGIN}/api/carrel/v1${path}`, {
      method: path.endsWith("/draft") ? "PUT" : "POST",
      headers: { authorization: `Bearer ${SITE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

async function carrelVersion(id: string): Promise<string> {
  const res = await handleCarrelRequest(
    new Request(`${ORIGIN}/api/carrel/v1/content/${id}`, { headers: { authorization: `Bearer ${SITE_KEY}` } }),
    envFor(),
    ctx,
  );
  return ((await res!.json()) as { version: string }).version;
}

function freshDb() {
  const { db } = createInMemoryDb();
  harness.db = db;
  return db;
}

function expectFoxhoundSubmission(c: Captured, slug: string) {
  expect(c.url).toBe(ENDPOINT);
  expect(c.body).toEqual({
    host: "foxhoundapp.com",
    key: INDEXNOW_KEY,
    keyLocation: `https://foxhoundapp.com/${INDEXNOW_KEY}.txt`,
    urlList: [`https://foxhoundapp.com/blog/${slug}`],
  });
}

describe("(a) the key file", () => {
  it("the key is 8 to 128 characters of IndexNow's alphabet, and is not Recova's", () => {
    expect(INDEXNOW_KEY).toMatch(/^[a-zA-Z0-9-]{8,128}$/);
    expect(INDEXNOW_KEY).not.toBe("recova2026indexnow");
    expect(INDEXNOW_KEY.toLowerCase()).not.toContain("recova");
    expect(INDEXNOW_KEY_PATH).toBe(`/${INDEXNOW_KEY}.txt`);
  });

  it("the route serves exactly the key, 200, as plain text, with no trailing newline", async () => {
    const res = keyRoute.loader();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(INDEXNOW_KEY);
  });

  it("is mounted at the site root under its own name, and caches like the other files", () => {
    const paths = (routes as Array<{ path?: string; file: string }>).filter((r) => r.file.endsWith("routes/files/indexnow-key.ts"));
    expect(paths.map((r) => r.path)).toEqual([`${INDEXNOW_KEY}.txt`]);
    expect(classifyPath(INDEXNOW_KEY_PATH)).toBe("files");
  });
});

describe("(b) a publish submits exactly Foxhound's changed URL", () => {
  it("Carrel: a draft save of an unpublished post submits nothing; publish submits the one URL", async () => {
    freshDb();
    expect((await carrel("/content/p1/draft", { source: SOURCE, expectedVersion: null, changeId: "c1" }))?.status).toBe(200);
    await settled();
    expect(captured).toEqual([]);

    const pub = await carrel("/content/p1/publish", { expectedVersion: await carrelVersion("p1"), changeId: "c2" });
    expect(pub?.status).toBe(200);
    await settled();
    expect(captured).toHaveLength(1);
    expectFoxhoundSubmission(captured[0], "why-cards-fail");
  });

  it("Carrel: a save of an already published post submits it again (Recova fires on every live save)", async () => {
    freshDb();
    await carrel("/content/p1/draft", { source: SOURCE, expectedVersion: null, changeId: "c1" });
    await carrel("/content/p1/publish", { expectedVersion: await carrelVersion("p1"), changeId: "c2" });
    await settled();
    captured = [];
    await new Promise((r) => setTimeout(r, 5));
    const edited = SOURCE.replace("Hello", "Goodbye");
    const saved = await carrel("/content/p1/draft", { source: edited, expectedVersion: await carrelVersion("p1"), changeId: "c3" });
    expect(saved?.status).toBe(200);
    await settled();
    expect(captured).toHaveLength(1);
    expectFoxhoundSubmission(captured[0], "why-cards-fail");
  });

  it("Carrel: unpublish submits nothing", async () => {
    freshDb();
    await carrel("/content/p1/draft", { source: SOURCE, expectedVersion: null, changeId: "c1" });
    await carrel("/content/p1/publish", { expectedVersion: await carrelVersion("p1"), changeId: "c2" });
    await settled();
    captured = [];
    await new Promise((r) => setTimeout(r, 5));
    const un = await carrel("/content/p1/unpublish", { expectedVersion: await carrelVersion("p1"), changeId: "c3" });
    expect(un?.status).toBe(200);
    await settled();
    expect(captured).toEqual([]);
  });

  it("a site not running at https://foxhoundapp.com (local dev, a preview) never pings the engine", async () => {
    freshDb();
    const local = envFor("http://localhost:5173");
    await carrel("/content/p1/draft", { source: SOURCE, expectedVersion: null, changeId: "c1" }, local);
    const pub = await carrel("/content/p1/publish", { expectedVersion: await carrelVersion("p1"), changeId: "c2" }, local);
    expect(pub?.status).toBe(200);
    await settled();
    expect(captured).toEqual([]);
  });

  it("the helper drops URLs that are not Foxhound's and is a no-op on an empty list", async () => {
    await indexNow.submitToIndexNow([]);
    await indexNow.submitToIndexNow(["https://recovamrr.com/blog/x", "http://foxhoundapp.com/blog/y"]);
    expect(captured).toEqual([]);
    await indexNow.submitToIndexNow(["https://recovamrr.com/blog/x", "https://foxhoundapp.com/blog/z"]);
    expect(captured).toHaveLength(1);
    expect(captured[0].body.urlList).toEqual(["https://foxhoundapp.com/blog/z"]);
  });
});

const ACTOR = "admin@foxhoundapp.com";

function adminCall(postId: string, fields: Record<string, string>, siteOrigin = ORIGIN) {
  const context = {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: envFor(siteOrigin), ctx, nonce: "n" };
      if (key === adminContext) return { email: ACTOR };
      throw new Error("unexpected context key");
    },
  };
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const request = new Request(`${ORIGIN}/admin/blog/${postId}`, { method: "POST", body });
  return adminDetail.action({ context, request, params: { id: postId } } as never) as unknown as Promise<{
    data: { ok: boolean };
  }>;
}

async function seedPost(db: ReturnType<typeof freshDb>) {
  return createPost(db, {
    title: "Dunning that works",
    slug: "dunning-that-works",
    excerpt: "",
    body: "Body.",
    author: "Foxhound",
    tags: [],
    featured: false,
  });
}

describe("(b) the /admin/blog editor path", () => {
  it("save of a draft submits nothing; publish submits the one URL; a save of the live post submits again", async () => {
    const db = freshDb();
    const id = await seedPost(db);

    expect((await adminCall(id, { _intent: "save", title: "Dunning that works", body: "Edited." })).data.ok).toBe(true);
    await settled();
    expect(captured).toEqual([]);

    expect((await adminCall(id, { _intent: "publish" })).data.ok).toBe(true);
    await settled();
    expect(captured).toHaveLength(1);
    expectFoxhoundSubmission(captured[0], "dunning-that-works");

    captured = [];
    expect((await adminCall(id, { _intent: "save", title: "Dunning that works", body: "Edited again." })).data.ok).toBe(true);
    await settled();
    expect(captured).toHaveLength(1);
    expectFoxhoundSubmission(captured[0], "dunning-that-works");

    captured = [];
    expect((await adminCall(id, { _intent: "unpublish" })).data.ok).toBe(true);
    await settled();
    expect(captured).toEqual([]);
  });
});

describe("(c) a failed submission never fails or delays the publish", () => {
  it.each([
    ["fetch rejects", () => Promise.reject(new Error("network down"))],
    ["fetch returns 500", async () => new Response("boom", { status: 500 })],
  ])("Carrel publish succeeds when %s", async (_label, failing) => {
    freshDb();
    fetchImpl = failing as () => Promise<Response>;
    await carrel("/content/p1/draft", { source: SOURCE, expectedVersion: null, changeId: "c1" });
    const pub = await carrel("/content/p1/publish", { expectedVersion: await carrelVersion("p1"), changeId: "c2" });
    expect(pub?.status).toBe(200);
    expect(((await pub!.json()) as { status: string }).status).toBe("published");
    await settled();
    expect(captured).toHaveLength(1);
  });

  it.each([
    ["fetch rejects", () => Promise.reject(new Error("network down"))],
    ["fetch returns 500", async () => new Response("boom", { status: 500 })],
  ])("admin publish succeeds when %s", async (_label, failing) => {
    const db = freshDb();
    const id = await seedPost(db);
    fetchImpl = failing as () => Promise<Response>;
    expect((await adminCall(id, { _intent: "publish" })).data.ok).toBe(true);
    expect((await getPostForAdmin(db, id))?.published).toBe(true);
    await settled();
    expect(captured).toHaveLength(1);
  });

  it("a submission that never answers does not hold up the publish (fire and forget)", async () => {
    const db = freshDb();
    const id = await seedPost(db);
    fetchImpl = () => new Promise<Response>(() => {});
    const result = await Promise.race([
      adminCall(id, { _intent: "publish" }).then(() => "returned"),
      new Promise((r) => setTimeout(() => r("held"), 500)),
    ]);
    expect(result).toBe("returned");
    expect(captured).toHaveLength(1);
  });
});
