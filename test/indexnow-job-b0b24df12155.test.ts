import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminContext } from "~/lib/admin/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { serializePostSource } from "~/lib/carrel/source";

import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

// IndexNow (job_b0b24df12155, row F20). Recova is the spec: it publishes a key
// file at /<key>.txt and, on every save that leaves a blog post published, POSTs
// that post's one URL to api.indexnow.org without waiting and without ever
// failing the save. Foxhound does the same with its OWN key (Dustin, Q15,
// 2026-10-14, "new key"): never Recova's key, never its filename.

const harness = vi.hoisted(() => ({ db: null as unknown, d1: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const { INDEXNOW_KEY } = await import("~/lib/seo/indexnow-key");
const keyRoute = await import("~/routes/files/indexnow-key");
const { handleCarrelRequest } = await import("~/lib/carrel/handler.server");
const adminDetail = await import("~/routes/admin/blog/detail");
const { createPost } = await import("~/lib/blog/admin-queries.server");

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

/** The env every request sees, dev and previews included: wrangler.jsonc sets
 *  BETTER_AUTH_URL to production, so the env cannot tell them apart. */
function envFor(): Env {
  const stub = { hit: async () => ({ ok: true, retryAfterSeconds: 0 }) };
  return {
    DB: harness.d1,
    CARREL_SITE_KEY: SITE_KEY,
    BETTER_AUTH_URL: ORIGIN,
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

function carrel(path: string, body: unknown, origin = ORIGIN) {
  const env = envFor();
  return handleCarrelRequest(
    new Request(`${origin}/api/carrel/v1${path}`, {
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
  const { db, sqlite } = createInMemoryDb();
  harness.db = db;
  harness.d1 = d1Over(sqlite);
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

  it("the route serves exactly the key, 200, as plain text, with no trailing newline", async () => {
    const res = keyRoute.loader();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(INDEXNOW_KEY);
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
});

const ACTOR = "admin@foxhoundapp.com";

function adminCall(postId: string, fields: Record<string, string>, origin = ORIGIN) {
  const context = {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: envFor(), ctx, nonce: "n" };
      if (key === adminContext) return { email: ACTOR };
      throw new Error("unexpected context key");
    },
  };
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const request = new Request(`${origin}/admin/blog/${postId}`, { method: "POST", body });
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

// Not IndexNow, but the same Carrel-plus-editor harness: an update Carrel
// scheduled on a live post replaces the whole post at its time, so the editor
// must say so before a save there is silently undone (site-api v0.10.0).
describe("the /admin/blog editor and a scheduled update", () => {
  it("warns before a save, with the waiting update's time in the admin's exact form", async () => {
    const db = freshDb();
    const id = await seedPost(db);
    await adminCall(id, { _intent: "publish" });
    const context = { get: () => ({ env: envFor(), ctx, nonce: "n" }) };
    const load = () => adminDetail.loader({ context, params: { id } } as never);
    expect((await load()).saveWarning).toBeNull();

    const sched = await carrel(`/content/${id}/schedule`, {
      expectedVersion: await carrelVersion(id),
      changeId: "c9",
      publishAt: "2030-01-01T15:00:00Z",
    });
    expect(sched?.status).toBe(200);
    expect((await load()).saveWarning).toContain("scheduled for 1 January 2030, 15:00 UTC.");
  });
});

// THE GUARD IS THE REQUEST'S ORIGIN, not the env (review of job_b0b24df12155).
// Every env here says https://foxhoundapp.com, as wrangler.jsonc does for dev
// and previews too; only the host the publish arrived on differs.
const ELSEWHERE = ["http://localhost:5173", "https://foxhound-preview.example.workers.dev"];

describe("(b) only a publish arriving on https://foxhoundapp.com submits", () => {
  it.each(ELSEWHERE)("Carrel publish on %s sends nothing", async (origin) => {
    freshDb();
    await carrel("/content/p1/draft", { source: SOURCE, expectedVersion: null, changeId: "c1" }, origin);
    const pub = await carrel("/content/p1/publish", { expectedVersion: await carrelVersion("p1"), changeId: "c2" }, origin);
    expect(pub?.status).toBe(200);
    await settled();
    expect(captured).toEqual([]);
  });
});
