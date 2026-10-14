import { createElement } from "react";
import type { EntryContext, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { page404Daily } from "~/db/schema";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J21: the 404 count is written from handleRequest, the one place every
// document 404 passes through: an unmatched URL and a route that throws a 404
// both arrive here with responseStatusCode 404, as Recova's not-found.tsx saw
// both. The write goes through ctx.waitUntil so it never holds or fails the
// page.
//
// ServerRouter is swapped for a trivial element: what is under test is the
// status branch and the scheduling, not React Router's render.

const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  ServerRouter: () => createElement("p", null, "page"),
}));

const { default: handleRequest } = await import("~/entry.server");

let db: ReturnType<typeof createInMemoryDb>["db"];
let scheduled: Promise<unknown>[];

beforeEach(() => {
  db = createInMemoryDb().db;
  harness.db = db;
  scheduled = [];
});

function loadContext() {
  const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => void scheduled.push(p)) };
  const provider = {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: {} as Env, ctx, nonce: "n" };
      throw new Error("unexpected context key");
    },
  } as unknown as RouterContextProvider;
  return { ctx, provider };
}

async function serve(method: string, status: number, url = "https://example.com/no-such-page?token=x") {
  const { ctx, provider } = loadContext();
  const response = await handleRequest(
    new Request(url, { method }),
    status,
    new Headers(),
    { isSpaMode: false } as EntryContext,
    provider,
  );
  await Promise.all(scheduled);
  return { ctx, response };
}

describe("handleRequest counts document 404s", () => {
  it("schedules the write on a GET 404 and the row lands with the path only", async () => {
    const { ctx, response } = await serve("GET", 404);
    expect(response.status).toBe(404);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    const stored = await db.select({ path: page404Daily.path, hits: page404Daily.hitCount }).from(page404Daily);
    expect(stored).toEqual([{ path: "/no-such-page", hits: 1 }]);
  });

  it("does not count a 200", async () => {
    const { ctx } = await serve("GET", 200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("does not count a HEAD 404", async () => {
    const { ctx } = await serve("HEAD", 404);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("still serves the page when the write fails, and logs the failure", async () => {
    harness.db = {
      insert: () => {
        throw new Error("d1 down");
      },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, response } = await serve("GET", 404);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("page");
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("page_404_daily"), expect.any(Error));
    logged.mockRestore();
  });
});
