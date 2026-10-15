import { eq } from "drizzle-orm";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { accounts, emailSuppressions } from "~/db/schema";
import { checkRateLimitWindow, type RateLimitWindow } from "~/lib/http/rate-limit-window";

import { createInMemoryDb } from "./helpers/inmemory-db";

// Row F7 (J26, job_652baa37855c): the /u/:token page against Recova's
// app/api/unsubscribe/route.ts (blob 31de4bc5, read whole). Recova is the spec
// for the states, their copy, the per-IP limit and the layout; Foxhound's engine
// stays (the HMAC token, suppression keyed by address, the RFC 8058 POST, no-store).
//
// Recova's four states and their exact words:
//   no token        "Invalid unsubscribe link."                                    (X)
//   unknown token   "This unsubscribe link is invalid or has expired."             (X)
//   suppressed      "{email} is already unsubscribed."                             (check)
//   newly done      "You've been unsubscribed. You won't receive any more recovery emails." (check)
// and 10 requests per 60 seconds per IP, else 429 "Too many requests". The
// route is u/:token, so Recova's no-token state cannot arise and an absent
// token reads as the invalid state.

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("~/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/db")>()),
  getDb: () => harness.db,
}));

const route = await import("~/routes/utility/unsubscribe");
const { signUnsubscribeToken } = await import("~/lib/email/unsubscribe-token");
const { isSuppressed } = await import("~/lib/email/suppression");

const ACCOUNT = "acct_sample";
const EMAIL = "sam@example.com";

/** The real fixed-window algorithm behind a fake namespace, as test/rate-limit.test.ts does. */
function fakeRateLimiter() {
  const storage = new Map<string, RateLimitWindow | undefined>();
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn((id: string) => ({
    check: (limit: number, periodMs: number) =>
      checkRateLimitWindow(
        {
          getWindow: async () => storage.get(id),
          putWindow: async (w) => {
            storage.set(id, w);
          },
        },
        Date.now(),
        limit,
        periodMs,
      ),
  }));
  return { idFromName, get };
}

function makeEnv(rateLimiter = fakeRateLimiter()) {
  return { ENCRYPTION_KEY: "a".repeat(64), RATE_LIMITER: rateLimiter } as unknown as Env;
}

const context = (env: Env): unknown => ({
  get: () => ({ env, ctx: {} as ExecutionContext, nonce: "n" }),
});

async function seed() {
  const { db } = createInMemoryDb();
  harness.db = db;
  await db.insert(accounts).values({ id: ACCOUNT, name: "Sample" });
  return db;
}

type LoaderData = Awaited<ReturnType<typeof route.loader>>;

const callLoader = async (env: Env, token: string | undefined): Promise<LoaderData> =>
  route.loader({
    params: { token },
    request: new Request(`https://foxhoundapp.test/u/${token ?? ""}`),
    context: context(env),
  } as never);

const suppressionRows = async (db: Awaited<ReturnType<typeof seed>>) =>
  db.select().from(emailSuppressions).where(eq(emailSuppressions.email, EMAIL));

// ============================================================================

describe("F7 loader: Recova's four states on Foxhound's engine", () => {
  it("a valid first visit suppresses the address and reports it newly done", async () => {
    const db = await seed();
    const env = makeEnv();
    const token = await signUnsubscribeToken(env, { email: EMAIL, accountId: ACCOUNT });

    expect(await callLoader(env, token)).toEqual({ state: "done" });
    const rows = await suppressionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("unsubscribe");
    expect(rows[0]?.suppressedAt).not.toBeNull();
  });

  it("a second visit reads 'already unsubscribed' and names the address, as Recova does", async () => {
    const db = await seed();
    const env = makeEnv();
    const token = await signUnsubscribeToken(env, { email: EMAIL, accountId: ACCOUNT });

    await callLoader(env, token);
    expect(await callLoader(env, token)).toEqual({ state: "already", email: EMAIL });
    expect(await suppressionRows(db)).toHaveLength(1);
  });

  it("an address a bounce already suppressed reads 'already unsubscribed' (Recova: any suppressed_at)", async () => {
    const db = await seed();
    const env = makeEnv();
    await db.insert(emailSuppressions).values({
      email: EMAIL,
      token: "evt_bounce",
      reason: "bounce",
      accountId: ACCOUNT,
      suppressedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    const token = await signUnsubscribeToken(env, { email: EMAIL, accountId: ACCOUNT });

    expect(await callLoader(env, token)).toEqual({ state: "already", email: EMAIL });
    const rows = await suppressionRows(db);
    expect(rows[0]?.reason).toBe("bounce");
  });

  it("a migrated Recova row with no suppressed_at is suppressed now and records this opt-out", async () => {
    // Recova registered a token row per send with suppressed_at NULL. Such a row
    // conflicts on the address; skipping it would say "already" while mail kept going.
    const db = await seed();
    const env = makeEnv();
    await db.insert(accounts).values({ id: "acct_other", name: "Other" });
    await db.insert(emailSuppressions).values({
      email: EMAIL,
      token: "tok_recova_registered",
      reason: null,
      accountId: "acct_other",
      suppressedAt: null,
    });
    expect(await isSuppressed(env, EMAIL)).toBe(false);
    const token = await signUnsubscribeToken(env, { email: EMAIL, accountId: ACCOUNT });

    expect(await callLoader(env, token)).toEqual({ state: "done" });
    const rows = await suppressionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.suppressedAt).not.toBeNull();
    expect(rows[0]?.reason).toBe("unsubscribe");
    expect(rows[0]?.token).toBe(token);
    expect(rows[0]?.accountId).toBe(ACCOUNT);
    expect(await isSuppressed(env, EMAIL)).toBe(true);
    expect(await callLoader(env, token)).toEqual({ state: "already", email: EMAIL });
  });

  it("a tampered or unknown token is the invalid state and writes nothing", async () => {
    const db = await seed();
    const env = makeEnv();
    expect(await callLoader(env, "not-a-token")).toEqual({ state: "invalid" });
    expect(await callLoader(env, " ")).toEqual({ state: "invalid" });
    expect(await suppressionRows(db)).toHaveLength(0);
  });

  it("no token at all folds into the invalid state (the route cannot deliver one)", async () => {
    await seed();
    expect(await callLoader(makeEnv(), undefined)).toEqual({ state: "invalid" });
  });
});

describe("F7 rate limit: Recova's 10 per 60 seconds per IP on the page", () => {
  const middleware = () => {
    const fns = (route as { middleware?: unknown[] }).middleware;
    expect(Array.isArray(fns), "the route exports a middleware list").toBe(true);
    return (fns as Array<(args: unknown, next: () => Promise<unknown>) => Promise<unknown>>)[0];
  };

  const hit = (env: Env, method = "GET", ip = "203.0.113.7") => {
    const next = vi.fn(async () => new Response("page"));
    const result = middleware()(
      {
        request: new Request("https://foxhoundapp.test/u/tok", {
          method,
          headers: { "cf-connecting-ip": ip },
        }),
        params: { token: "tok" },
        context: context(env),
      },
      next,
    );
    return { result, next };
  };

  it("lets ten GETs through and answers the eleventh 429 'Too many requests' as plain text", async () => {
    const env = makeEnv();
    for (let i = 0; i < 10; i++) {
      const { result, next } = hit(env);
      await result;
      expect(next).toHaveBeenCalledTimes(1);
    }
    const { result, next } = hit(env);
    const res = (await result) as Response;
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(await res.text()).toBe("Too many requests");
  });

  it("keys the budget on its own bucket and the caller's IP", async () => {
    const limiter = fakeRateLimiter();
    const env = makeEnv(limiter);
    await hit(env, "GET", "198.51.100.4").result;
    expect(limiter.idFromName).toHaveBeenCalledWith("unsubscribe:198.51.100.4");
  });

  it("does not spend the budget on the RFC 8058 one-click POST (Recova had no POST)", async () => {
    const limiter = fakeRateLimiter();
    const env = makeEnv(limiter);
    for (let i = 0; i < 12; i++) {
      const { result, next } = hit(env, "POST");
      await result;
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(limiter.idFromName).not.toHaveBeenCalled();
  });
});

describe("F7 page: Recova's copy and layout on Capsomer's parts", () => {
  const Page = route.default as unknown as ComponentType<{ loaderData: LoaderData }>;

  function render(loaderData: LoaderData): string {
    const router = createMemoryRouter(
      [{ path: "*", element: createElement(Page, { loaderData }) }],
      { initialEntries: ["/u/tok"] },
    );
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  }

  /** The page body after the shared site header. */
  function main(html: string): string {
    const i = html.indexOf("<main");
    expect(i, "the page has a main landmark").toBeGreaterThan(-1);
    return html.slice(i);
  }

  const STATES = [
    { data: { state: "invalid" }, copy: "This unsubscribe link is invalid or has expired.", ok: false },
    { data: { state: "already", email: EMAIL }, copy: `${EMAIL} is already unsubscribed.`, ok: true },
    {
      data: { state: "done" },
      copy: "You&#x27;ve been unsubscribed. You won&#x27;t receive any more recovery emails.",
      ok: true,
    },
  ] as const;

  it.each(STATES)("$data.state says Recova's words exactly", ({ data, copy }) => {
    expect(main(render(data as LoaderData))).toContain(`>${copy}</p>`);
  });

  it.each(STATES)("$data.state shows Recova's round status mark in the right tone", ({ data, ok }) => {
    const body = main(render(data as LoaderData));
    const mark = body.match(/<div[^>]*data-status-mark="(ok|crit)"[^>]*>/);
    expect(mark, "the status circle is drawn").not.toBeNull();
    expect(mark?.[1]).toBe(ok ? "ok" : "crit");
    expect(mark?.[0]).toContain("rounded-full");
    expect(mark?.[0]).toContain("size-12");
  });

  it.each([
    { data: { state: "invalid" }, heading: "Unsubscribe link not valid" },
    { data: { state: "already", email: EMAIL }, heading: "Already unsubscribed" },
    { data: { state: "done" }, heading: "Unsubscribed" },
  ] as const)("$data.state names its outcome in a visually hidden h1", ({ data, heading }) => {
    const body = main(render(data as LoaderData));
    const h1s = [...body.matchAll(/<h1 class="sr-only">([^<]*)<\/h1>/g)].map((m) => m[1]);
    expect(h1s).toEqual([heading]);
  });

  it.each(STATES)("$data.state announces the result through a status paragraph", ({ data, copy }) => {
    const body = main(render(data as LoaderData));
    expect(body).toMatch(new RegExp(`<p role="status"[^>]*>${copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
  });

  it("keeps the site header and puts Recova's wordmark above a Capsomer panel", () => {
    const html = render({ state: "done" } as LoaderData);
    expect(html).toContain("cap-site-header");
    const body = main(html);
    expect(body).toContain('data-family="teal"');
    expect(body).toContain("fh-cap");
    const wordmark = body.indexOf("hound</span>");
    const panel = body.indexOf('class="cap-panel"');
    expect(wordmark).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(wordmark);
  });

  it("uses Recova's column: 480px wide, 40px by 24px padding, centred text", () => {
    const body = main(render({ state: "done" } as LoaderData));
    expect(body).toMatch(/class="[^"]*max-w-\[480px\][^"]*px-6[^"]*py-10[^"]*text-center/);
  });

  it("links 'Return to Foxhound' home with a target at least 24px tall", () => {
    const body = main(render({ state: "invalid" } as LoaderData));
    const link = body.match(/<a [^>]*>Return to Foxhound<\/a>/);
    expect(link, "the return link is on the page").not.toBeNull();
    expect(link?.[0]).toContain('href="/"');
    expect(link?.[0]).toContain("min-h-[var(--target)]");
    expect(link?.[0]).toContain("underline");
  });

  it("uses only the five text sizes and no amber", () => {
    const html = render({ state: "already", email: EMAIL } as LoaderData);
    expect(html).not.toMatch(/amber/);
    const body = main(html);
    for (const m of body.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (/^text-\[/.test(base) && !/^text-\[var\(--/.test(base)) {
          throw new Error(`arbitrary text size ${c}`);
        }
      }
    }
    expect(body).toContain("text-body");
    expect(body).toContain("text-label");
    expect(body).toContain("text-title");
  });
});
