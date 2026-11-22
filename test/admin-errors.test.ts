import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminAuditLog } from "~/db";
import { sentryApiBase } from "~/lib/admin/errors.server";
import * as route from "~/routes/admin/errors";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import { createInMemoryDb } from "./helpers/inmemory-db";

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const DSN = "https://publickey@o4501.ingest.us.sentry.io/4502";
const FAKE_TOKEN = "sntrys_fake_token_for_tests";

function sentryIssue(i: number, over: Record<string, unknown> = {}) {
  return {
    id: String(9000 + i),
    shortId: `FOXHOUND-${i}`,
    title: `TypeError: thing ${i} is undefined`,
    culprit: `app/lib/thing${i}.ts in run`,
    permalink: `https://example-org.sentry.io/issues/${9000 + i}/`,
    level: "error",
    status: "unresolved",
    count: String(10 + i),
    userCount: i,
    firstSeen: "2026-10-01T10:00:00.000Z",
    lastSeen: "2026-10-15T09:00:00.000Z",
    ...over,
  };
}

function contextWith(env: Partial<Env>) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: env as Env, ctx: {} as ExecutionContext });
  return context;
}

type LoaderData = {
  sentry: Record<string, unknown> & { state: string };
  failed: Array<Record<string, unknown>>;
};

async function runLoader(env: Partial<Env>): Promise<LoaderData> {
  const loader = route.loader as (args: unknown) => Promise<LoaderData>;
  return loader({
    request: new Request("https://foxhoundapp.com/admin/platform/errors"),
    context: contextWith(env),
    params: {},
  });
}

beforeEach(() => {
  harness.db = createInMemoryDb().db;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whether Sentry can be read", () => {
  it("says not connected while SENTRY_DSN is unset, and never calls out", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const data = await runLoader({ SENTRY_AUTH_TOKEN: FAKE_TOKEN, SENTRY_ORG: "example-org" });
    expect(data.sentry).toEqual({ state: "not-connected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the read settings that are missing when only the DSN is set", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await runLoader({ SENTRY_DSN: DSN })).sentry).toEqual({
      state: "no-reader",
      missing: ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"],
    });
    expect((await runLoader({ SENTRY_DSN: DSN, SENTRY_ORG: "example-org" })).sentry).toEqual({
      state: "no-reader",
      missing: ["SENTRY_AUTH_TOKEN"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads the API in the DSN's own region, for the DSN's own project", () => {
    const base = sentryApiBase;
    expect(base(DSN)).toEqual({ apiBase: "https://us.sentry.io", projectId: "4502" });
    expect(base("https://k@o1.ingest.de.sentry.io/77")).toEqual({
      apiBase: "https://de.sentry.io",
      projectId: "77",
    });
    expect(base("https://k@o1.ingest.sentry.io/12")).toEqual({
      apiBase: "https://sentry.io",
      projectId: "12",
    });
    // Never sends the token anywhere but Sentry's own API.
    expect(base("https://k@sentry.example.com/12")).toBeNull();
    expect(base("https://k@o1.ingest.us.sentry.io.evil.example/12")).toBeNull();
    expect(base("not a url")).toBeNull();
    expect(base("https://k@o1.ingest.us.sentry.io/")).toBeNull();
  });

  it("lists the project's unresolved issues, newest first, with the token in the header only", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json([
        sentryIssue(1),
        sentryIssue(2, { level: "warning", permalink: "javascript:alert(1)" }),
      ]),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const data = await runLoader({
      SENTRY_DSN: DSN,
      SENTRY_AUTH_TOKEN: FAKE_TOKEN,
      SENTRY_ORG: "example-org",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(
      "https://us.sentry.io/api/0/organizations/example-org/issues/",
    );
    expect(u.searchParams.get("project")).toBe("4502");
    expect(u.searchParams.get("query")).toBe("is:unresolved");
    expect(u.searchParams.get("sort")).toBe("date");
    expect(u.searchParams.get("statsPeriod")).toBe("14d");
    expect(url).not.toContain(FAKE_TOKEN);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
    // A followed redirect would carry the token to another host.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("manual");

    expect(data.sentry.state).toBe("ready");
    const issues = data.sentry.issues as Array<Record<string, unknown>>;
    expect(issues[0]).toMatchObject({
      id: "9001",
      shortId: "FOXHOUND-1",
      title: "TypeError: thing 1 is undefined",
      culprit: "app/lib/thing1.ts in run",
      level: "error",
      count: 11,
      userCount: 1,
      permalink: "https://example-org.sentry.io/issues/9001/",
    });
    expect(issues[0].lastSeen).toEqual(new Date("2026-10-15T09:00:00.000Z"));
    expect(issues[0].firstSeen).toEqual(new Date("2026-10-01T10:00:00.000Z"));
    // A link that is not Sentry's own https page is dropped, never rendered.
    expect(issues[1].permalink).toBeNull();
    expect(JSON.stringify(data)).not.toContain(FAKE_TOKEN);
  });

  it("says what Sentry answered when the read fails, without the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const data = await runLoader({
      SENTRY_DSN: DSN,
      SENTRY_AUTH_TOKEN: FAKE_TOKEN,
      SENTRY_ORG: "example-org",
    });
    expect(data.sentry.state).toBe("failed");
    expect(String(data.sentry.message)).toMatch(/refused the token/i);
    expect(JSON.stringify(data)).not.toContain(FAKE_TOKEN);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    const missing = await runLoader({
      SENTRY_DSN: DSN,
      SENTRY_AUTH_TOKEN: FAKE_TOKEN,
      SENTRY_ORG: "example-org",
    });
    expect(String(missing.sentry.message)).toMatch(/example-org/);

    // A 3xx is a failed read with its status, never followed.
    for (const status of [301, 302, 307, 308]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(null, { status, headers: { location: "https://elsewhere.example/" } }),
        ),
      );
      const moved = await runLoader({
        SENTRY_DSN: DSN,
        SENTRY_AUTH_TOKEN: FAKE_TOKEN,
        SENTRY_ORG: "example-org",
      });
      expect(moved.sentry.state, String(status)).toBe("failed");
      expect(String(moved.sentry.message), String(status)).toContain(`(${status})`);
      expect(String(moved.sentry.message)).not.toContain("elsewhere.example");
    }
    // An opaque redirect (what workerd and browsers return for redirect:
    // "manual") has status 0 and type opaqueredirect; it is a failed read too.
    const opaque = {
      ok: false,
      status: 0,
      type: "opaqueredirect",
      json: async () => [],
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => opaque),
    );
    const hidden = await runLoader({
      SENTRY_DSN: DSN,
      SENTRY_AUTH_TOKEN: FAKE_TOKEN,
      SENTRY_ORG: "example-org",
    });
    expect(hidden.sentry.state).toBe("failed");
    expect(String(hidden.sentry.message)).toMatch(/redirect/i);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const down = await runLoader({
      SENTRY_DSN: DSN,
      SENTRY_AUTH_TOKEN: FAKE_TOKEN,
      SENTRY_ORG: "example-org",
    });
    expect(down.sentry.state).toBe("failed");
    expect(String(down.sentry.message)).toMatch(/did not answer/i);
  });
});

describe("failed actions from the audit log", () => {
  it("keeps only actions that name an error or a failure, newest first, in words", async () => {
    const { db } = createInMemoryDb();
    const at = (min: number) => new Date(Date.now() - min * 60 * 1000);
    await db.insert(adminAuditLog).values([
      {
        id: "a1",
        actorEmail: "ops@example.com",
        action: "staged.failed",
        metadata: { stagedId: "s", kind: "pause", error: "No such account" },
        createdAt: at(30),
      },
      {
        id: "a2",
        actorEmail: "ops@example.com",
        action: "cron.disable",
        metadata: { cronName: "recovery-tick" },
        createdAt: at(20),
      },
      {
        id: "a3",
        actorEmail: "account-owner",
        action: "user_self_deleted_account_deauthorize_failed",
        targetUserId: "u1",
        metadata: { connection_id: "c", error: "Stripe said no" },
        createdAt: at(10),
      },
      {
        id: "a4",
        actorEmail: "ops@example.com",
        action: "import_ERROR_seen",
        metadata: null,
        createdAt: at(5),
      },
    ]);
    harness.db = db;
    vi.stubGlobal("fetch", vi.fn());
    const { failed } = await runLoader({});
    expect(failed.map((e) => e.id)).toEqual(["a4", "a3", "a1"]);
    expect(failed[2]).toMatchObject({
      action: "A staged change failed to apply",
      detail: "No such account",
    });
    expect(failed[1]).toMatchObject({ actor: "The account owner", detail: "Stripe said no" });
  });
});
