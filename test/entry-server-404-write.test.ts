import { createElement } from "react";
import type { EntryContext, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { page404Daily } from "~/db/schema";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J21: the 404 count is written from handleRequest (every document 404) and
// handleDataRequest (a client navigation whose loader throws a 404). The
// counting itself is site-runtime's countNotFound, tested there; this proves
// Foxhound's wiring reaches it and that its upsert fits Foxhound's own
// migrated page_404_daily table.
//
// ServerRouter is swapped for a trivial element: what is under test is the
// wiring, not React Router's render.

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  ServerRouter: () => createElement("p", null, "page"),
}));

const { default: handleRequest, handleDataRequest } = await import("~/entry.server");

let memory: ReturnType<typeof createInMemoryDb>;
let scheduled: Promise<unknown>[];

beforeEach(() => {
  memory = createInMemoryDb();
  scheduled = [];
});

/** The D1 surface countNotFound uses, over the in-memory SQLite. D1 takes
 *  `?1`-style numbered parameters; better-sqlite3 binds them as plain `?`, in
 *  order, which is how the upsert numbers them. */
function d1() {
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => memory.sqlite.prepare(sql.replace(/\?\d+/g, "?")).run(...values),
      }),
    }),
  };
}

function loadContext() {
  const ctx = { waitUntil: vi.fn((p: Promise<unknown>) => void scheduled.push(p)) };
  const provider = {
    get(key: unknown) {
      if (key === cloudflareContext) return { env: { DB: d1() } as unknown as Env, ctx, nonce: "n" };
      throw new Error("unexpected context key");
    },
  } as unknown as RouterContextProvider;
  return { ctx, provider };
}

async function stored() {
  return memory.db.select({ path: page404Daily.path, hits: page404Daily.hitCount }).from(page404Daily);
}

describe("404s are counted into page_404_daily", () => {
  it("a document 404, twice, is one row with two hits and no query", async () => {
    for (let i = 0; i < 2; i++) {
      const { provider } = loadContext();
      const response = await handleRequest(
        new Request("https://example.com/no-such-page?token=x"),
        404,
        new Headers(),
        { isSpaMode: false } as EntryContext,
        provider,
      );
      expect(response.status).toBe(404);
      await Promise.all(scheduled);
    }
    expect(await stored()).toEqual([{ path: "/no-such-page", hits: 2 }]);
  });

  it("a GET .data 404 counts against the page it loads", async () => {
    const { ctx, provider } = loadContext();
    const response = handleDataRequest(new Response("x", { status: 404 }), {
      request: new Request("https://example.com/blog/gone.data?_routes=x"),
      context: provider,
    });
    await Promise.all(scheduled);
    expect(response.status).toBe(404);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual([{ path: "/blog/gone", hits: 1 }]);
  });
});
