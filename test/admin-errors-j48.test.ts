import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminAuditLog } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// J48 (job_4217eaf96f91): /admin/platform/errors on the family admin pattern
// (Capsomer's parts, Dustin's Q9 of 2026-10-14) and his 2026-10-11 review.
// Recova's page (app/admin/platform/errors/page.tsx, blob 9cca8956) is the
// inventory: the last 50 audit log entries whose action names an error or a
// failure, with Time, Action, Actor, Target and Detail, and a note that Sentry
// would be wired in later. Foxhound writes such entries (staged.failed and the
// account deletion's deauthorize failure), so that list is ported. Sentry is
// read only when something writes to it (SENTRY_DSN set) and the page holds a
// read token and an organisation (RULES.md 3.18); until then the page says
// plainly that error reporting is not connected.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

// Looked up so a missing module or export fails the assertion that names it,
// not the whole file (RULES.md 6.5).
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

// ---------------------------------------------------------------- the route

describe("the route", () => {
  it("is /admin/platform/errors, beside Recova's other Platform pages", () => {
    const routes = readFileSync("app/routes.ts", "utf8");
    expect(routes).toMatch(/route\("errors", "\.\/routes\/admin\/errors\.tsx"\)/);
    const platform = /prefix\("platform", \[([\s\S]*?)\]\)/.exec(routes)?.[1] ?? "";
    expect(platform).toContain('"errors"');
  });

  it("has a menu entry named Errors, between Crons and Webhooks as in Recova's nav", () => {
    const shell = readFileSync("app/layouts/admin-shell.tsx", "utf8");
    const ids = [...shell.matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)", href: "([^"]+)"/g)].map((m) => m.slice(1));
    const at = ids.findIndex(([id]) => id === "errors");
    expect(at).toBeGreaterThan(-1);
    expect(ids[at]).toEqual(["errors", "Errors", "/admin/platform/errors"]);
    expect(ids[at - 1]?.[0]).toBe("crons");
    expect(ids[at + 1]?.[0]).toBe("webhooks");
    expect(shell).toMatch(/id: "errors"[^\n]*group: "Platform"/);
  });
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

  it("shows Recova's 50 at most", async () => {
    const { db } = createInMemoryDb();
    await db.insert(adminAuditLog).values(
      Array.from({ length: 55 }, (_, i) => ({
        id: `f${i}`,
        actorEmail: "ops@example.com",
        action: "staged.failed",
        metadata: { error: "x" },
        createdAt: new Date(Date.now() - i * 1000),
      })),
    );
    harness.db = db;
    vi.stubGlobal("fetch", vi.fn());
    expect((await runLoader({})).failed).toHaveLength(50);
  });
});

// ---------------------------------------------------------------- the page

const Page = route.default as ((props: unknown) => React.ReactNode) | undefined;

function render(loaderData: LoaderData) {
  expect(typeof Page).toBe("function");
  const Stub = createRoutesStub([
    { path: "/admin/platform/errors", Component: () => createElement(Page as never, { loaderData } as never) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/admin/platform/errors"] }));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const readyIssues = [
  {
    id: "9001",
    shortId: "FOXHOUND-1",
    title: "TypeError: thing 1 is undefined",
    culprit: "app/lib/thing1.ts in run",
    level: "error",
    count: 1200,
    userCount: 3,
    firstSeen: new Date(Date.now() - 3 * 86400000),
    lastSeen: new Date(Date.now() - 3600000),
    permalink: "https://example-org.sentry.io/issues/9001/",
  },
  {
    id: "9002",
    shortId: "FOXHOUND-2",
    title: "Slow query",
    culprit: null,
    level: "warning",
    count: 1,
    userCount: 0,
    firstSeen: new Date(Date.now() - 86400000),
    lastSeen: new Date(Date.now() - 7200000),
    permalink: null,
  },
];

const failedEntry = {
  id: "a1",
  createdAt: new Date(Date.now() - 600000),
  actor: "ops@example.com",
  action: "A staged change failed to apply",
  target: { label: "Pause Acme", href: "/admin/staged" },
  detail: "No such account",
};

describe("the Errors page", () => {
  it("says plainly that error reporting is not connected, in a teal-family notice", () => {
    const html = render({ sentry: { state: "not-connected" }, failed: [] });
    const t = text(html);
    expect(t).toContain("Error reporting is not connected.");
    expect(t).toContain("SENTRY_DSN");
    expect(html).toMatch(/class="cap-banner"[^>]*data-tone="info"/);
    expect(html).not.toMatch(/data-tone="warn"/);
  });

  it("names the missing read settings when errors are sent but cannot be read here", () => {
    const t = text(render({ sentry: { state: "no-reader", missing: ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"] }, failed: [] }));
    expect(t).toContain("Errors are sent to Sentry, but this page cannot read them yet.");
    expect(t).toContain("SENTRY_AUTH_TOKEN and SENTRY_ORG");
  });

  it("says when the DSN is not one it can read from", () => {
    expect(text(render({ sentry: { state: "unreadable-dsn" }, failed: [] }))).toContain(
      "This page reads only from sentry.io",
    );
  });

  it("shows a failed read as Capsomer's failed empty state with Sentry's answer", () => {
    const html = render({ sentry: { state: "failed", message: "Sentry refused the token (401)." }, failed: [] });
    expect(html).toMatch(/class="cap-empty"[^>]*data-kind="failed"/);
    expect(text(html)).toContain("Could not read errors from Sentry.");
    expect(text(html)).toContain("Sentry refused the token (401).");
  });

  it("lists unresolved issues in a captioned Capsomer table in sentence case", () => {
    const html = render({ sentry: { state: "ready", issues: readyIssues }, failed: [] });
    const t = text(html);
    expect(t).toContain("2 unresolved errors seen in the last 14 days, most recent first.");
    const tables = [...html.matchAll(/<table class="cap-table">([\s\S]*?)<\/table>/g)];
    expect(tables).toHaveLength(1);
    const headers = [...tables[0][1].matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]).trim());
    expect(headers).toEqual(["Error", "Level", "Events", "Users", "Last seen", "First seen"]);
    expect(tables[0][1]).toMatch(/<caption[^>]*>[^<]*unresolved errors/i);
    expect(t).toContain("1,200");
    expect(t).toContain("TypeError: thing 1 is undefined");
    expect(t).toContain("app/lib/thing1.ts in run");
    expect(t).toContain("Warning");
    expect(html).not.toMatch(/\buppercase\b|\btracking-/);
  });

  it("opens an issue in Sentry from a real link with a 24 px target and an icon", () => {
    const html = render({ sentry: { state: "ready", issues: readyIssues }, failed: [] });
    const link = /<a [^>]*href="https:\/\/example-org\.sentry\.io\/issues\/9001\/"[^>]*>[\s\S]*?<\/a>/.exec(html)?.[0] ?? "";
    expect(link).toMatch(/class="[^"]*\bmin-h-6\b/);
    expect(link).toMatch(/rel="noreferrer"/);
    expect(link).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(text(link)).toMatch(/opens in Sentry/);
    // The issue with no safe link shows its title as plain text.
    expect(html).not.toMatch(/href="null"|href=""/);
  });

  it("says all clear when Sentry has nothing unresolved", () => {
    const html = render({ sentry: { state: "ready", issues: [] }, failed: [] });
    expect(html).toMatch(/data-kind="all-clear"/);
    expect(text(html)).toContain("No unresolved errors in the last 14 days.");
  });

  it("lists failed actions with Recova's five columns, and an empty state", () => {
    const html = render({ sentry: { state: "not-connected" }, failed: [failedEntry] });
    const t = text(html);
    expect(t).toContain("Failed actions");
    expect(t).toContain("Showing the last 1 failed action, newest first.");
    const headers = [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]).trim());
    // Recova's errors page orders them Time, Action, Actor (not the audit log's order).
    expect(headers).toEqual(["Time", "Action", "Actor", "Target", "Detail"]);
    expect(t).toContain("No such account");
    expect(html).toMatch(/role="tooltip"/);

    const empty = text(render({ sentry: { state: "not-connected" }, failed: [] }));
    expect(empty).toContain("No failed actions in the audit log.");
  });

  it("scrolls each table in its own labelled region on a phone", () => {
    const html = render({ sentry: { state: "ready", issues: readyIssues }, failed: [failedEntry] });
    const regions = html.match(/<div class="cap-table-wrap"[^>]*role="region"[^>]*aria-labelledby="[^"]+"[^>]*tabindex="0"/gi) ?? [];
    expect(regions).toHaveLength(2);
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

  it("exists and names itself once for the top bar", () => {
    expect(source).toMatch(/export const handle: AdminHandle = \{ page: "Errors" \}/);
    expect(source).not.toMatch(/<h1\b/);
  });

  it("has no amber and no hand-sized text", () => {
    expect(source).toMatch(/\S/);
    expect(source).not.toMatch(/amber|orange|warning-text|tone="warn"|text-\[/);
  });

  it("marks its lists busy while they are read again", () => {
    expect(source).toMatch(/pagePending\(/);
    expect(source).toMatch(/aria-busy=/);
  });

  it("never names the read token in what it renders", () => {
    expect(source).not.toMatch(/SENTRY_AUTH_TOKEN\b(?!")/);
    expect(read("app/lib/admin/errors.server.ts")).toMatch(/Authorization/);
  });
});
