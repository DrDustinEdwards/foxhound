import { readFileSync } from "node:fs";

import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminAuditLog } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J48: /admin/platform/errors on the family admin pattern
// (Capsomer's parts, Dustin's Q9 of 2026-10-14) and his 2026-10-11 review.
// Recova's page (app/admin/platform/errors/page.tsx, blob 9cca8956) is the
// inventory: the last 50 audit log entries whose action names an error or a
// failure, with Time, Action, Actor, Target and Detail, and a note that Sentry
// would be wired in later. Foxhound writes such entries (staged.failed and the
// account deletion's deauthorize failure), so that list is ported. Sentry is
// read only when something writes to it (SENTRY_DSN set) and the page holds a
// read token and an organization; until then the page says
// plainly that error reporting is not connected.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// Looked up so a missing module or export fails the assertion that names it,
// not the whole file.
const route: Record<string, unknown> = await import("~/routes/admin/errors").catch(() => ({}));
const lib: Record<string, unknown> = await import("~/lib/admin/errors.server").catch(() => ({}));

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
  context.set(cloudflareContext, { env: env as Env, ctx: {} as ExecutionContext, nonce: "" });
  return context;
}

type LoaderData = {
  sentry: Record<string, unknown> & { state: string };
  failed: Array<Record<string, unknown>>;
};

async function runLoader(env: Partial<Env>): Promise<LoaderData> {
  expect(typeof route.loader).toBe("function");
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

// ---------------------------------------------------------------- reading Sentry

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
    expect(typeof lib.sentryApiBase).toBe("function");
    const base = lib.sentryApiBase as (dsn: string) => { apiBase: string; projectId: string } | null;
    expect(base(DSN)).toEqual({ apiBase: "https://us.sentry.io", projectId: "4502" });
    expect(base("https://k@o1.ingest.de.sentry.io/77")).toEqual({ apiBase: "https://de.sentry.io", projectId: "77" });
    expect(base("https://k@o1.ingest.sentry.io/12")).toEqual({ apiBase: "https://sentry.io", projectId: "12" });
    // Never sends the token anywhere but Sentry's own API.
    expect(base("https://k@sentry.example.com/12")).toBeNull();
    expect(base("https://k@o1.ingest.us.sentry.io.evil.example/12")).toBeNull();
    expect(base("not a url")).toBeNull();
    expect(base("https://k@o1.ingest.us.sentry.io/")).toBeNull();
  });

  it("says plainly when the DSN is not one this page can read from", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const data = await runLoader({ SENTRY_DSN: "https://k@sentry.example.com/12", SENTRY_AUTH_TOKEN: FAKE_TOKEN, SENTRY_ORG: "o" });
    expect(data.sentry.state).toBe("unreadable-dsn");
  });

  it("lists the project's unresolved issues, newest first, with the token in the header only", async () => {
    const fetchSpy = vi.fn(async () => Response.json([sentryIssue(1), sentryIssue(2, { level: "warning", permalink: "javascript:alert(1)" })]));
    vi.stubGlobal("fetch", fetchSpy);
    const data = await runLoader({ SENTRY_DSN: DSN, SENTRY_AUTH_TOKEN: FAKE_TOKEN, SENTRY_ORG: "example-org" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://us.sentry.io/api/0/organizations/example-org/issues/");
    expect(u.searchParams.get("project")).toBe("4502");
    expect(u.searchParams.get("query")).toBe("is:unresolved");
    expect(u.searchParams.get("sort")).toBe("date");
    expect(u.searchParams.get("statsPeriod")).toBe("14d");
    expect(url).not.toContain(FAKE_TOKEN);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
    // Review of #94: the read has a timeout, and a redirect is never followed
    // (a followed redirect would carry the token to another host).
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
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const data = await runLoader({ SENTRY_DSN: DSN, SENTRY_AUTH_TOKEN: FAKE_TOKEN, SENTRY_ORG: "example-org" });
    expect(data.sentry.state).toBe("failed");
    expect(String(data.sentry.message)).toMatch(/refused the token/i);
    expect(JSON.stringify(data)).not.toContain(FAKE_TOKEN);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const missing = await runLoader({ SENTRY_DSN: DSN, SENTRY_AUTH_TOKEN: FAKE_TOKEN, SENTRY_ORG: "example-org" });
    expect(String(missing.sentry.message)).toMatch(/example-org/);

    // Review of #94: a 3xx is a failed read with its status, never followed.
    for (const status of [301, 302, 307, 308]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status, headers: { location: "https://elsewhere.example/" } })),
      );
      const moved = await runLoader({ SENTRY_DSN: DSN, SENTRY_AUTH_TOKEN: FAKE_TOKEN, SENTRY_ORG: "example-org" });
      expect(moved.sentry.state, String(status)).toBe("failed");
      expect(String(moved.sentry.message), String(status)).toContain(`(${status})`);
      expect(String(moved.sentry.message)).not.toContain("elsewhere.example");
    }
    // An opaque redirect (what workerd and browsers return for redirect:
    // "manual") has status 0 and type opaqueredirect; it is a failed read too.
    const opaque = { ok: false, status: 0, type: "opaqueredirect", json: async () => [] } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn(async () => opaque));
    const hidden = await runLoader({ SENTRY_DSN: DSN, SENTRY_AUTH_TOKEN: FAKE_TOKEN, SENTRY_ORG: "example-org" });
    expect(hidden.sentry.state).toBe("failed");
    expect(String(hidden.sentry.message)).toMatch(/redirect/i);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const down = await runLoader({ SENTRY_DSN: DSN, SENTRY_AUTH_TOKEN: FAKE_TOKEN, SENTRY_ORG: "example-org" });
    expect(down.sentry.state).toBe("failed");
    expect(String(down.sentry.message)).toMatch(/did not answer/i);
  });
});

// ---------------------------------------------------------------- Recova's list

describe("failed actions from the audit log (Recova's list)", () => {
  it("keeps only actions that name an error or a failure, newest first, in words", async () => {
    const { db } = createInMemoryDb();
    const at = (min: number) => new Date(Date.now() - min * 60 * 1000);
    await db.insert(adminAuditLog).values([
      { id: "a1", actorEmail: "ops@example.com", action: "staged.failed", metadata: { stagedId: "s", kind: "pause", error: "No such account" }, createdAt: at(30) },
      { id: "a2", actorEmail: "ops@example.com", action: "cron.disable", metadata: { cronName: "recovery-tick" }, createdAt: at(20) },
      { id: "a3", actorEmail: "account-owner", action: "user_self_deleted_account_deauthorize_failed", targetUserId: "u1", metadata: { connection_id: "c", error: "Stripe said no" }, createdAt: at(10) },
      { id: "a4", actorEmail: "ops@example.com", action: "import_ERROR_seen", metadata: null, createdAt: at(5) },
    ]);
    harness.db = db;
    vi.stubGlobal("fetch", vi.fn());
    const { failed } = await runLoader({});
    expect(failed.map((e) => e.id)).toEqual(["a4", "a3", "a1"]);
    expect(failed[2]).toMatchObject({ action: "A staged change failed to apply", detail: "No such account" });
    expect(failed[1]).toMatchObject({ actor: "The account owner", detail: "Stripe said no" });
  });
});

describe("the page source", () => {
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const source = read("app/routes/admin/errors.tsx");

  it("never names the read token in what it renders", () => {
    expect(source).not.toMatch(/SENTRY_AUTH_TOKEN\b(?!")/);
    expect(read("app/lib/admin/errors.server.ts")).toMatch(/Authorization/);
  });
});
