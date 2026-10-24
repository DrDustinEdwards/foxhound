
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_LOOKBACK_DAYS,
  AUDIT_OAUTH_STATE_COOKIE,
  AUDIT_TOKEN_COOKIE,
  STRIPE_AUDIT_SCOPE,
} from "~/lib/constants";
import { AUDIT_ACTION, buildConnectState } from "~/lib/stripe/connect-state";
import { readAuditGrantCookie } from "~/lib/stripe/state-cookie";

// J42 (job_c6e2110edde1), rows U1 and U5: /audit/connect, the free audit's
// consent page, and /audit/callback, its OAuth return.
//
// Recova is the spec for the page's content, layout and features:
// app/audit/connect/page.tsx (blob 9d7075d8, 2139 bytes) and its button,
// app/audit/connect/AuditConnectButton.tsx (blob f3301cf0, 1430 bytes), both
// read whole. One 480px card, 48px inside at every width, holding the h1
// "Connect your Stripe account", the line under it, a box with WHAT WE CAN DO
// and WHAT WE CAN NEVER DO, the full-width "Connect Stripe and see my numbers
// →" button and "Read-only · Secure · Free · See a demo first". Its parts are
// Capsomer's (Q12), teal (Q11), on the five text sizes (RULES.md 5.2).
//
// The OAuth pair (Recova's app/api/audit/connect/route.ts, blob dedddf99, and
// app/audit/callback/route.ts, blob 0cf90598) is driven through the REAL
// action and loader. The scope is read_only (RULES.md 2.2), the state is a
// minted pair matched against an HttpOnly cookie (RULES.md 4.6), and no
// refusal names who holds an account (RULES.md 4.14).

const exchange = vi.hoisted(() => ({ impl: null as unknown, calls: 0 }));
vi.mock("~/lib/stripe/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/stripe/connect")>();
  return {
    ...actual,
    exchangeConnectCode: (...args: unknown[]) => {
      exchange.calls += 1;
      return (exchange.impl as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const connectRoute = await import("~/routes/audit/connect");
const callbackRoute = await import("~/routes/audit/callback");
const AuditConnect = connectRoute.default;

const ORIGIN = "https://foxhoundapp.test";
const STRIPE_ACCOUNT = "acct_stripe_alpha";
const TOKEN = "sk_live_audit_token_j42";

function envWith(allowed = true): Env {
  return {
    STRIPE_CLIENT_ID: "ca_test_client",
    BETTER_AUTH_URL: ORIGIN,
    // PR #127 seals the audit grant cookie with this key.
    ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
    RATE_LIMITER: {
      idFromName: () => "id",
      get: () => ({ hit: async () => ({ ok: allowed, retryAfterSeconds: 60 }) }),
    },
  } as unknown as Env;
}

const routeContext = (env: Env = envWith()): unknown => ({
  get: () => ({ env, ctx: {} as ExecutionContext, nonce: "n" }),
});

const setCookies = (response: Response): string[] => response.headers.getSetCookie();

// ---------------------------------------------------------------------------
// The rendered page

type Props = Parameters<typeof AuditConnect>[0];
type LoaderData = Props["loaderData"];

function render(loaderData: LoaderData): string {
  const props = { loaderData, params: {}, matches: [] } as unknown as Props;
  const router = createMemoryRouter([{ path: "*", element: createElement(AuditConnect, props) }], {
    initialEntries: ["/audit/connect"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}


function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}





const PAGE: LoaderData = { lookbackDays: AUDIT_LOOKBACK_DAYS, stripeEnabled: true, error: null };

describe("J42 U1: refusals in a Capsomer alert, never naming an account, never echoing the URL", () => {

  it("an unknown code shows the fallback and never reflects the query string", () => {
    const hostile = '<img src=x onerror=alert(1)>acct_stranger owned by Dana';
    const html = render({ ...PAGE, error: hostile });
    expect(text(html)).toContain("Could not connect Stripe. Please try again.");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("acct_stranger");
    expect(html).not.toContain("Dana");
  });
});

// ---------------------------------------------------------------------------
// The OAuth pair, through the real action and loader

describe("J42 U1: the start is a POST, and a GET mints nothing", () => {
  it("the page's GET loader sets no cookie and starts no flow", () => {
    const out = connectRoute.loader({
      request: new Request(`${ORIGIN}/audit/connect`),
      context: routeContext(),
      params: {},
    } as never);
    expect(out).not.toBeInstanceOf(Response);
    expect(out).toEqual({ lookbackDays: AUDIT_LOOKBACK_DAYS, stripeEnabled: true, error: null });
  });

  it("the POST asks Stripe for read_only, with a fresh state each time, in an HttpOnly cookie", async () => {
    const start = async () =>
      (await connectRoute.action({
        request: new Request(`${ORIGIN}/audit/connect`, { method: "POST" }),
        context: routeContext(),
        params: {},
      } as never)) as Response;
    const [a, b] = [await start(), await start()];
    const sa = new URL(a.headers.get("Location")!).searchParams;
    const sb = new URL(b.headers.get("Location")!).searchParams;
    expect(sa.get("scope")).toBe(STRIPE_AUDIT_SCOPE);
    expect(sa.get("scope")).toBe("read_only");
    expect(sa.get("state")).not.toBe(sb.get("state"));
    const cookie = setCookies(a).find((c) => c.startsWith(`${AUDIT_OAUTH_STATE_COOKIE}=`))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);
    // The cookie holds exactly the state Stripe will echo back, and it says
    // "audit", so the callback can match it and refuse any other flow's.
    const value = decodeURIComponent(cookie.split(";")[0].slice(AUDIT_OAUTH_STATE_COOKIE.length + 1));
    expect(value).toBe(sa.get("state"));
    expect(JSON.parse(value).action).toBe(AUDIT_ACTION);
  });
});

describe("J42 U5: the callback refuses before it exchanges, and every exit clears the state", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    exchange.calls = 0;
    exchange.impl = async () => ({
      stripeUserId: STRIPE_ACCOUNT,
      accessToken: TOKEN,
      publishableKey: null,
      scope: STRIPE_AUDIT_SCOPE,
    });
    errorSpy.mockClear();
  });
  afterEach(() => errorSpy.mockClear());

  const call = (params: Record<string, string>, cookie: string | null, env: Env = envWith()) => {
    const url = new URL(`${ORIGIN}/audit/callback`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return callbackRoute.loader({
      request: new Request(url, { headers: cookie ? { Cookie: `${AUDIT_OAUTH_STATE_COOKIE}=${cookie}` } : {} }),
      context: routeContext(env),
      params: {},
    } as never) as Promise<Response>;
  };

  /** A refusal: back to the consent page with the code, the state cleared, no token. */
  function expectRefused(response: Response, reason: string) {
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/audit/connect?error=${reason}`);
    const cookies = setCookies(response);
    expect(cookies.some((c) => c.startsWith(`${AUDIT_OAUTH_STATE_COOKIE}=;`) && c.includes("Max-Age=0"))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${AUDIT_TOKEN_COOKIE}=`))).toBe(false);
  }

  it("over the rate limit: refused before anything else, never exchanged", async () => {
    const state = buildConnectState(AUDIT_ACTION);
    const response = await call({ code: "ac_1", state }, state, envWith(false));
    expectRefused(response, "rate_limited");
    expect(exchange.calls).toBe(0);
  });

  it("Stripe's error and a missing code both come back as cancelled", async () => {
    const state = buildConnectState(AUDIT_ACTION);
    expectRefused(await call({ error: "access_denied", state }, state), "cancelled");
    expectRefused(await call({ state }, state), "cancelled");
    expect(exchange.calls).toBe(0);
  });

  it("a grant with no scope at all is refused, fail closed, with no token cookie", async () => {
    exchange.impl = async () => ({ stripeUserId: STRIPE_ACCOUNT, accessToken: TOKEN, publishableKey: null, scope: null });
    const state = buildConnectState(AUDIT_ACTION);
    expectRefused(await call({ code: "ac_1", state }, state), "scope_refused");
  });

  it("a failed exchange is refused as failed, and nothing from it is logged", async () => {
    exchange.impl = async () => {
      throw new Error(`Stripe said no for ${TOKEN}`);
    };
    const state = buildConnectState(AUDIT_ACTION);
    expectRefused(await call({ code: "ac_1", state }, state), "failed");
    for (const args of errorSpy.mock.calls) expect(JSON.stringify(args.map(String))).not.toContain(TOKEN);
  });

  it("success: a same-site relative redirect, the token only in a sealed five-minute /audit cookie", async () => {
    const state = buildConnectState(AUDIT_ACTION);
    const response = await call({ code: "ac_1", state }, state);
    const location = response.headers.get("Location")!;
    expect(location).toBe(`/audit/results?account=${STRIPE_ACCOUNT}`);
    expect(location.startsWith("/") && !location.startsWith("//")).toBe(true);
    expect(location).not.toContain(TOKEN);
    const cookies = setCookies(response);
    const token = cookies.find((c) => c.startsWith(`${AUDIT_TOKEN_COOKIE}=`))!;
    expect(token).toMatch(/; HttpOnly; Secure; SameSite=Lax; Path=\/audit; Max-Age=300$/);
    // Sealed (PR #127): the value never carries the token in plain text, and
    // it opens to exactly the grant this callback was given.
    const value = token.split(";")[0].slice(AUDIT_TOKEN_COOKIE.length + 1);
    expect(value).not.toBe("");
    expect(value).not.toContain(TOKEN);
    expect(decodeURIComponent(value)).not.toContain(TOKEN);
    const grant = await readAuditGrantCookie(
      envWith(),
      new Request(`${ORIGIN}/audit/results`, { headers: { Cookie: `${AUDIT_TOKEN_COOKIE}=${value}` } }),
    );
    expect(grant).toEqual({ accessToken: TOKEN, stripeAccountId: STRIPE_ACCOUNT });
    expect(cookies.some((c) => c.startsWith(`${AUDIT_OAUTH_STATE_COOKIE}=;`))).toBe(true);
    for (const args of errorSpy.mock.calls) expect(JSON.stringify(args.map(String))).not.toContain(TOKEN);
  });
});
