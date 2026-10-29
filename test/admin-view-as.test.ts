import { asc } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accountMembers, accounts, adminAuditLog, adminImpersonations, user, type Db } from "~/db";
import { adminContext } from "~/lib/admin/context";
import { IMPERSONATION_COOKIE, IMPERSONATION_READ_ONLY_MESSAGE } from "~/lib/admin/impersonation.server";
import { authContext } from "~/lib/auth/context";
import { appShellMiddleware } from "~/lib/auth/guards";
import { cloudflareContext } from "~/lib/cloudflare-context";

import { createInMemoryDb } from "./helpers/inmemory-db";

// "View as merchant" (Recova's Impersonate, read-only) end to end against the
// real schema: start from /admin, the app shell resolving the merchant, the
// read-only 405, the Access re-check, Stop, expiry on the next request, and the
// four audit rows. The admin passes Access through access.server.ts's own
// localhost bypass, so the Access check is the real one.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));
// The admin has no merchant session of their own.
vi.mock("~/lib/auth/session", () => ({ getSession: async () => null }));

const start = await import("~/routes/admin/view-as");
const stop = await import("~/routes/admin/view-as-stop");

const ADMIN = "admin@example.com";
const ACCOUNT = "acct_north";
const env = { ACCESS_DEV_BYPASS: "1", ADMIN_EMAIL: ADMIN } as unknown as Env;
const T0 = Date.parse("2026-10-29T12:00:00.000Z");

let db: Db;

function ctx(admin = true) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext, nonce: "" });
  if (admin) context.set(adminContext, { email: ADMIN });
  return context;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected a throw");
}

function shell(url: string, cookie: string, method = "GET") {
  const request = new Request(url, { method, headers: { cookie } });
  const context = ctx(false);
  const next = vi.fn(async () => new Response("page"));
  const run = appShellMiddleware(
    { request, context, params: {}, url: new URL(url), pattern: "/console" },
    next,
  ) as Promise<Response>;
  return { run, next, context };
}

async function begin(): Promise<string> {
  const form = new FormData();
  form.set("accountId", ACCOUNT);
  const res = (await start.action({
    request: new Request("http://localhost/admin/view-as", { method: "POST", body: form }),
    context: ctx(),
    params: {},
  } as never)) as Response;
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/console");
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).not.toContain(ACCOUNT);
  return setCookie.split(";")[0];
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  const made = createInMemoryDb();
  db = made.db;
  harness.db = db;
  await db.insert(accounts).values({ id: ACCOUNT, name: "North Supply" });
  await db.insert(user).values({ id: "u_owner", name: "Nora North", email: "nora@north.test" });
  await db.insert(accountMembers).values({ accountId: ACCOUNT, userId: "u_owner", role: "owner", status: "active" });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("View as merchant", () => {
  it("starts, stays read-only, needs Access, stops, expires, and logs each step", async () => {
    const cookie = await begin();

    // The app shell resolves the merchant's account from the row.
    const view = shell("http://localhost/console", cookie);
    await view.run;
    expect(view.next).toHaveBeenCalled();
    expect(view.context.get(authContext)).toMatchObject({
      activeAccountId: ACCOUNT,
      membership: { accountName: "North Supply", role: "owner" },
      isAdmin: false,
      viewingAs: { adminEmail: ADMIN },
    });

    // Read-only: a POST is refused with the 405 before anything else runs.
    const post = shell("http://localhost/recovery/payments/pay_1", cookie, "POST");
    const refused = (await caught(post.run)) as { data: unknown; init: { status: number } };
    expect(refused.data).toBe(IMPERSONATION_READ_ONLY_MESSAGE);
    expect(refused.init.status).toBe(405);
    expect(post.next).not.toHaveBeenCalled();

    // No bypass of Access: off the admin's Access-verified request, the cookie
    // is worthless and is cleared.
    const stranger = shell("https://foxhoundapp.com/console", cookie);
    const toLogin = (await caught(stranger.run)) as Response;
    expect(toLogin.headers.get("Location")).toBe("/login");
    expect(toLogin.headers.get("Set-Cookie")).toContain(`${IMPERSONATION_COOKIE}=;`);
    expect(stranger.next).not.toHaveBeenCalled();

    // Stop ends the row and returns to the merchant's admin page.
    vi.setSystemTime(T0 + 60 * 1000);
    const stopped = (await stop.loader({
      request: new Request("http://localhost/admin/view-as/stop", { headers: { cookie } }),
      context: ctx(),
      params: {},
    } as never)) as Response;
    expect(stopped.headers.get("Location")).toBe(`/admin/merchants/${ACCOUNT}`);
    expect(stopped.headers.get("Set-Cookie")).toContain(`${IMPERSONATION_COOKIE}=;`);
    const afterStop = shell("http://localhost/console", cookie);
    await caught(afterStop.run);
    expect(afterStop.next).not.toHaveBeenCalled();

    // A second view, left open past 30 minutes, ends on the next request.
    vi.setSystemTime(T0 + 2 * 60 * 1000);
    const second = await begin();
    vi.setSystemTime(T0 + 33 * 60 * 1000);
    const late = shell("http://localhost/console", second);
    expect(((await caught(late.run)) as Response).headers.get("Location")).toBe("/login");
    expect(late.next).not.toHaveBeenCalled();

    const rows = await db.select().from(adminImpersonations).orderBy(asc(adminImpersonations.startedAt));
    expect(rows.map((r) => r.endReason)).toEqual(["stopped", "expired"]);
    const audit = await db.select().from(adminAuditLog).orderBy(asc(adminAuditLog.createdAt));
    expect(audit.map((a) => [a.actorEmail, a.action, (a.metadata as { reason?: string }).reason ?? null])).toEqual([
      [ADMIN, "impersonation_start", null],
      [ADMIN, "impersonation_stop", "stopped"],
      [ADMIN, "impersonation_start", null],
      [ADMIN, "impersonation_stop", "expired"],
    ]);
    expect(audit.every((a) => (a.metadata as { accountId: string }).accountId === ACCOUNT)).toBe(true);
  });
});
