import { createSiteApi } from "@dustinedwards/site-api";
import { runConformance } from "@dustinedwards/site-api/conformance";
import { d1ScheduledUpdates } from "@dustinedwards/site-api/schedules";
import { describe, expect, it, vi } from "vitest";

import { renderMarkdown } from "~/lib/blog/markdown.server";
import { carrelAdapter } from "~/lib/carrel/adapter.server";
import { carrelMediaAdapter } from "~/lib/carrel/media-adapter.server";
import { serializePostSource } from "~/lib/carrel/source";
import { loader as mediaLoader } from "~/routes/files/media";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb, d1Over } from "./helpers/inmemory-db";

// The media route reads the index through getDb(env).
const route = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("~/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("~/db")>()), getDb: () => route.db }));

// The blog's media library through Carrel's real site-api mount, over the real
// schema (migration 0059's tables and triggers) and in-memory stand-ins for the
// R2 bucket, the Images binding and Workers AI.

const KEY = "k".repeat(40);
const ORIGIN = "https://foxhoundapp.com";
const BASE = `${ORIGIN}/api/carrel/v1`;

/** A PNG header of the given size (enough for the stand-in Images binding to measure), made unique by `tag`. */
function png(width: number, height: number, tag = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes[39] = tag;
  return bytes;
}

const sizeOf = (bytes: Uint8Array) => ({ width: new DataView(bytes.buffer, bytes.byteOffset).getUint32(16), height: new DataView(bytes.buffer, bytes.byteOffset).getUint32(20) });

async function bytesOf(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
}

function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>();
  let n = 0;
  const view = (key: string) => {
    const o = objects.get(key);
    if (!o) return null;
    return {
      key,
      etag: o.etag,
      httpEtag: `"${o.etag}"`,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
      body: new Response(o.bytes.slice()).body!,
      arrayBuffer: async () => o.bytes.slice().buffer,
      writeHttpMetadata: (headers: Headers) => headers.set("content-type", o.httpMetadata?.contentType ?? "application/octet-stream"),
    };
  };
  return {
    objects,
    head: async (key: string) => view(key),
    get: async (key: string) => view(key),
    async put(key: string, value: unknown, options: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; onlyIf?: { etagMatches: string } } = {}) {
      if (options.onlyIf && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      objects.set(key, { bytes: await bytesOf(value), etag: `e${++n}`, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata });
      return view(key);
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) objects.delete(key);
    },
  };
}

/** Measures the PNG header; a transform writes a header of the new size, so the bytes really change. */
const fakeImages = {
  info: async (stream: ReadableStream) => ({ format: "image/png", fileSize: 40, ...sizeOf(await bytesOf(stream)) }),
  input: (stream: ReadableStream) => ({
    transform: (t: { rotate?: number; width?: number; height?: number }) => ({
      output: async () => {
        const { width, height } = sizeOf(await bytesOf(stream));
        const turned = t.rotate === 90 || t.rotate === 270 ? { width: height, height: width } : { width, height };
        const scale = t.width ? Math.min(1, t.width / Math.max(turned.width, turned.height)) : 1;
        const out = png(Math.round(turned.width * scale), Math.round(turned.height * scale), 200);
        return { response: () => new Response(out as BodyInit, { headers: { "content-type": "image/png" } }) };
      },
    }),
  }),
};

/** The answer fields these tests read. */
interface Answer {
  id: string;
  version: string;
  width: number;
  height: number;
  alt: string;
  placeholder: string | null;
  usedCount: number;
  usedBy: Array<{ type: string; id: string }>;
  currentVersion: string;
  resizedFrom?: { width: number; height: number };
  duplicateOf?: string;
  revisions: Array<{ rev: string; reason: string }>;
  changeCursor: string;
  items: Array<{ id: string }>;
  removed: string[];
}

function setup() {
  const { db, sqlite } = createInMemoryDb();
  const bucket = fakeBucket();
  const env = {
    MEDIA: bucket,
    IMAGES: fakeImages,
    AI: { run: async () => ({ response: '{"alt": "A bar chart of declines", "tags": ["chart", "declines"]}', usage: { prompt_tokens: 10, completion_tokens: 5 } }) },
  } as unknown as Env;
  const api = createSiteApi({
    adapter: { ...carrelAdapter(db, d1ScheduledUpdates(d1Over(sqlite))), media: carrelMediaAdapter(env, db) },
    key: KEY,
    limiter: { limit: async () => ({ success: true }) },
    log: () => {},
  });
  const call = (path: string, init: RequestInit = {}) =>
    api.handle(new Request(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } }));
  const json = async (path: string, init: RequestInit = {}) => {
    const response = await call(path, init);
    return { status: response.status, body: (await response.json()) as Answer };
  };
  const upload = (bytes: Uint8Array, name = "declines-chart.png", query = "") =>
    json(`/media?filename=${name}&decorative=yes&changeId=up-${++uploads}${query}`, { method: "POST", headers: { "content-type": "image/png" }, body: new Blob([bytes as BlobPart]) });
  const at = (id: string) => `/media/${encodeURIComponent(id)}`;
  return { db, sqlite, env, bucket, api, call, json, upload, at };
}

let uploads = 0;

const post = (body: string) =>
  serializePostSource({ title: "Why cards fail", slug: "why-cards-fail", excerpt: "Reasons.", author: "Foxhound", tags: [], featured: false, body });

describe("the media library through Carrel's site-api mount", () => {
  it("passes site-api's conformance suite, its own upload round trip included", async () => {
    const t = setup();
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      probeMediaUpload: true,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => t.api.handle(new Request(input as string, init))) as typeof fetch,
    });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("a picture a post cites renders responsive, counts as used, and cannot be deleted until the post lets go", async () => {
    const t = setup();
    const up = await t.upload(png(1600, 900));
    expect(up.status).toBe(201);
    const { id } = up.body;
    expect(id).toMatch(/^\d{4}\/\d{2}\/declines-chart-[0-9a-f]{8}\.png$/);
    // prepareUpload's placeholder is stored and answered with the file.
    expect(up.body.placeholder).toMatch(/^data:image\/webp;base64,/);
    expect((await t.json(t.at(id))).body.placeholder).toBe(up.body.placeholder);

    const created = await t.json("/content/p1/draft", {
      method: "PUT",
      body: JSON.stringify({ source: post(`![Declines by reason](/media/${id})\n`), expectedVersion: null, changeId: "c1" }),
    });
    expect(created.status).toBe(200);

    const { html } = await renderMarkdown(t.db, `![Declines by reason](/media/${id})\n`);
    expect(html).toContain("<picture>");
    // Named by its bytes, so the route serves each size immutable.
    expect(html).toMatch(new RegExp(`/media/${id}\\.webp\\?v=[0-9a-f]{12}&#x26;w=680 `));
    expect(html).toContain('width="1600" height="900"');

    const detail = await t.json(t.at(id));
    expect(detail.body.usedCount).toBe(1);
    expect(detail.body.usedBy[0]).toMatchObject({ type: "post", id: "p1" });

    const refused = await t.call(`${t.at(id)}?changeId=d1`, { method: "DELETE" });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { usedBy: Array<{ id: string }> }).usedBy.map((u) => u.id)).toEqual(["p1"]);
    expect(t.bucket.objects.has(id)).toBe(true);

    const doc = await t.json("/content/p1");
    await t.json("/content/p1/draft", { method: "PUT", body: JSON.stringify({ source: post("No picture now.\n"), expectedVersion: doc.body.version, changeId: "c2" }) });
    expect((await t.call(`${t.at(id)}?changeId=d2`, { method: "DELETE" })).status).toBe(200);
    expect(t.bucket.objects.has(id)).toBe(false);
  });

  it("a stale write is refused and changes nothing; the fresh one moves the version", async () => {
    const t = setup();
    const { body: item } = await t.upload(png(800, 600));
    const alt = (text: string, expectedVersion: string) =>
      t.json(`${t.at(item.id)}/alt`, { method: "PUT", body: JSON.stringify({ alt: text, expectedVersion, changeId: `a-${text.replace(/\W/g, "")}` }) });
    const first = await alt("A chart", item.version);
    expect(first.status).toBe(200);
    const stale = await alt("Another", item.version);
    expect(stale.status).toBe(409);
    expect(stale.body.currentVersion).toBe(first.body.version);
    expect((await t.json(t.at(item.id))).body.alt).toBe("A chart");
  });

  it("a large upload is shrunk, its original kept, and a revert brings the original back", async () => {
    const t = setup();
    const up = await t.upload(png(4000, 3000));
    expect(up.body.resizedFrom).toMatchObject({ width: 4000, height: 3000 });
    expect([up.body.width, up.body.height]).toEqual([2560, 1920]);

    const history = await t.json(`${t.at(up.body.id)}/history`);
    expect(history.body.revisions.map((r) => r.reason)).toEqual(["resize", "upload"]);
    const reverted = await t.json(`${t.at(up.body.id)}/revert`, {
      method: "POST",
      body: JSON.stringify({ to: history.body.revisions[1].rev, expectedVersion: up.body.version, changeId: "r1" }),
    });
    expect(reverted.status).toBe(200);
    expect([reverted.body.width, reverted.body.height]).toEqual([4000, 3000]);

    // The same camera file again is the file it already became, not a second copy.
    const again = await t.upload(png(4000, 3000));
    expect(again.body.duplicateOf ?? again.body.id).toBe(up.body.id);
  });

  it("the change log answers each write and each delete since a cursor", async () => {
    const t = setup();
    const kept = (await t.upload(png(800, 600, 1), "kept.png")).body;
    const gone = (await t.upload(png(800, 600, 2), "gone.png")).body;
    const cursor = (await t.json("/media?limit=1")).body.changeCursor;
    await t.json(`${t.at(kept.id)}/alt`, { method: "PUT", body: JSON.stringify({ alt: "A bar chart of declines by month", expectedVersion: kept.version, changeId: "a1" }) });
    await t.call(`${t.at(gone.id)}?changeId=d1`, { method: "DELETE" });
    const changes = await t.json(`/media?changedSince=${cursor}`);
    expect(changes.body.items.map((i) => i.id)).toEqual([kept.id]);
    expect(changes.body.removed).toEqual([gone.id]);
  });

  it("the public route serves an upload, immutable only at its current version, and never the earlier bytes kept beside it", async () => {
    const t = setup();
    const up = (await t.upload(png(4000, 3000))).body;
    const copy = [...t.bucket.objects.keys()].find((k) => k.startsWith("revisions/"));
    expect(copy).toBeDefined();
    vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
    route.db = t.db;
    const context = new Map([[cloudflareContext, { env: t.env }]]);
    const get = (key: string, query = "") =>
      mediaLoader({ params: { "*": key }, request: new Request(`${ORIGIN}/media/${key}${query}`), context } as unknown as Parameters<typeof mediaLoader>[0]);
    expect((await get(up.id)).headers.get("cache-control")).toBe("public, max-age=300");
    const [row] = t.sqlite.prepare("SELECT sha256 FROM media WHERE key = ?").all(up.id) as Array<{ sha256: string }>;
    expect((await get(up.id, `?v=${row!.sha256.slice(0, 12)}`)).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await get(up.id, "?v=000000000000")).headers.get("cache-control")).toBe("public, max-age=300");
    expect((await get(copy!)).status).toBe(404);
    vi.unstubAllGlobals();
  });
});
