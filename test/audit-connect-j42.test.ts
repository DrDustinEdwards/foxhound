import { readFileSync } from "node:fs";

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
      get: () => ({ check: async () => ({ allowed, retryAfterSec: 60 }) }),
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

function tagWith(html: string, cls: RegExp): string {
  const m = html.match(new RegExp(`<[a-z]+[^>]*class="[^"]*${cls.source}[^"]*"[^>]*>`));
  expect(m, `an element with ${cls.source} is on the page`).not.toBeNull();
  return m![0];
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function inOrder(haystack: string, needles: string[]) {
  let from = -1;
  for (const n of needles) {
    const i = haystack.indexOf(n, from + 1);
    expect(i, `"${n}" appears after the item before it`).toBeGreaterThan(from);
    from = i;
  }
}

/** Source with comments stripped, so a comment cannot satisfy an assertion. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

const FIVE_SIZES = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
const NOT_A_SIZE =
  /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|accent-hover|error-text|success-text|on-brand|brand-text|chrome-text|chrome-text-secondary|chrome-brand|wordmark|left|right|center)$/;

function sizeClasses(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) {
      const base = c.replace(/^[a-z0-9-]+:/g, "");
      if (base.startsWith("text-") && !NOT_A_SIZE.test(base)) out.push(base);
    }
  }
  return out;
}

const PAGE: LoaderData = { lookbackDays: AUDIT_LOOKBACK_DAYS, stripeEnabled: true, error: null };

describe("J42 U1: Recova's one card, built from Capsomer's parts", () => {
  it("one 480px column in a Capsomer panel inside the teal family wrapper", () => {
    const html = render(PAGE);
    const wrap = tagWith(html, /fh-cap/);
    expect(wrap).toContain('data-family="teal"');
    expect(wrap).toContain("max-w-[480px]");
    expect(html).toMatch(/<section class="cap-panel"><div class="cap-panel-body">/);
  });

  it("no second main landmark: the marketing layout already renders main", () => {
    expect(render(PAGE)).not.toMatch(/<main[\s>]/);
  });

  it("Recova's 48px inset at every width, phone included (p-12, no breakpoint)", () => {
    // The panel body carries --gap (12px) by --pad-card (16px); the inner div
    // adds 36px by 32px, which is Recova's 48px on all four sides, as the
    // sign-in card does. Recova's card has no smaller phone padding.
    const html = render(PAGE);
    expect(html).toMatch(/<div class="cap-panel-body"><div class="px-8 py-9">/);
    expect(html).not.toMatch(/md:p-12|p-8 md:/);
  });

  it("Recova's heading and the line under it, the window from the engine constant", () => {
    const html = render(PAGE);
    expect(html).toMatch(/<h1[^>]*>Connect your Stripe account<\/h1>/);
    expect(text(html)).toContain(
      `We need read-only access to scan your failed payments from the last ${AUDIT_LOOKBACK_DAYS} days. We never store your data permanently.`,
    );
  });

  it("Recova's order, every line word for word", () => {
    inOrder(text(render(PAGE)), [
      "Connect your Stripe account",
      "We need read-only access",
      "What we can do",
      "View failed invoices and payment history",
      "Scan decline codes and categories",
      "Calculate your recoverable revenue",
      "What we can never do",
      "Create new charges or move money",
      "Access your payouts or bank account",
      "Store your Stripe data permanently",
      "Connect Stripe and see my numbers",
      "Read-only · Secure · Free ·",
      "See a demo first",
    ]);
  });

  it("each list is a list, named by its heading, which keeps Recova's spacing (no added tracking)", () => {
    const html = render(PAGE);
    const lists = [...html.matchAll(/<ul[^>]*aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(lists).toHaveLength(2);
    expect(html).toMatch(new RegExp(`id="${lists[0]}"[^>]*>What we can do<`));
    expect(html).toMatch(new RegExp(`id="${lists[1]}"[^>]*>What we can never do<`));
    // Recova's labels are `text-xs font-medium` with no letter spacing.
    expect(html).not.toContain("tracking-wide");
    for (const li of html.match(/<li[^>]*>/g) ?? []) expect(li).toContain("text-label");
  });

  it("the ticks and crosses are hidden from assistive tech, so each line reads as its words", () => {
    const html = render(PAGE);
    const icons = html.match(/<svg[^>]*>/g) ?? [];
    expect(icons.length).toBeGreaterThanOrEqual(6);
    for (const svg of icons) expect(svg).toContain('aria-hidden="true"');
  });
});

describe("J42 U1: the one action is Capsomer's primary Button, full width as Recova's", () => {
  it("Connect Stripe and see my numbers submits a POST through a cap-btn primary", () => {
    const html = render(PAGE);
    const btn = tagWith(html, /cap-btn/);
    expect(btn).toMatch(/^<button/);
    expect(btn).toContain('type="submit"');
    expect(btn).toContain('data-variant="primary"');
    const form = html.match(/<form[^>]*>/g)?.find((f) => f.includes('method="post"'));
    expect(form, "a POST form is on the page").toBeDefined();
    expect(form).toContain('class="grid"');
  });

  it("keeps Recova's arrow, hidden from screen readers so the name is the words", () => {
    const html = render(PAGE);
    expect(html).toMatch(
      /<button[^>]*><span class="whitespace-normal">Connect Stripe and see my numbers<span aria-hidden="true"> →<\/span><\/span><\/button>/,
    );
  });

  it("the label may wrap, as Recova's does on a phone, so it is never clipped at 320px", () => {
    // Capsomer's button is white-space: nowrap; Recova's 33-character label
    // needs two lines below about 400px. The wrap sits on the page's own label.
    const html = render(PAGE);
    expect(html).toMatch(/<button[^>]*data-size="lg"[^>]*><span class="whitespace-normal">/);
  });

  it("no hand-rolled button and no Recova class strings are left", () => {
    const html = render(PAGE);
    expect(html).not.toMatch(/bg-purple|text-purple-bg|p-\[14px\]/);
  });

  it("pending says Recova's first step, the one that is true, and never the three it faked", () => {
    // Recova cycles four steps on an 1800ms timer while it has already left
    // for Stripe after 400ms, so "Reading invoices...", "Analyzing decline
    // codes..." and "Building summary..." describe work not happening (fixing
    // copy where Recova lied, RULES.md 1.2). "Connecting to Stripe..." is
    // true, so it stays, announced through a polite status region as Recova's
    // role="status" did.
    const src = code(readFileSync("app/routes/audit/connect.tsx", "utf8"));
    expect(src).toContain('"Connecting to Stripe..."');
    expect(src).not.toContain("Redirecting to Stripe");
    for (const fake of ["Reading invoices", "Analyzing decline codes", "Building summary"]) {
      expect(src).not.toContain(fake);
    }
    const html = render(PAGE);
    expect(html).toMatch(/<[a-z]+[^>]*role="status"[^>]*aria-live="polite"[^>]*>/);
  });

  describe("pending is shown only while THIS form posts (review round 1, must-fix 1)", () => {
    // The real component in a real memory router, with a loader on the demo
    // route and an action on this route that never settle, so the router
    // holds the navigation in flight while the page is rendered.
    const never = () => new Promise<never>(() => {});
    function liveRouter() {
      const props = { loaderData: PAGE, params: {}, matches: [] } as unknown as Props;
      return createMemoryRouter(
        [
          { path: "/audit/connect", element: createElement(AuditConnect, props), action: never },
          { path: "/demos/recovery", element: null, loader: never },
          { path: "/pricing", element: null, loader: never },
        ],
        { initialEntries: ["/audit/connect"] },
      );
    }
    const renderRouter = (router: ReturnType<typeof liveRouter>) =>
      renderToStaticMarkup(createElement(RouterProvider, { router }));
    const statusText = (html: string) =>
      html.match(/<span role="status"[^>]*>([^<]*)<\/span>/)?.[1] ?? null;

    it("idle: no busy button and an empty status region", () => {
      const html = renderRouter(liveRouter());
      expect(html).not.toContain('aria-busy="true"');
      expect(statusText(html)).toBe("");
    });

    for (const to of ["/demos/recovery", "/pricing"]) {
      it(`following a link to ${to} shows no pending state and announces nothing`, async () => {
        const router = liveRouter();
        void router.navigate(to);
        await Promise.resolve();
        expect(router.state.navigation.state).toBe("loading");
        const html = renderRouter(router);
        expect(html).not.toContain('aria-busy="true"');
        expect(statusText(html)).toBe("");
        expect(html).not.toContain("Connecting to Stripe...");
      });
    }

    it("posting this form shows the busy button and announces Connecting to Stripe...", async () => {
      const router = liveRouter();
      void router.navigate("/audit/connect", { formMethod: "post", formData: new FormData() });
      await Promise.resolve();
      expect(router.state.navigation.state).toBe("submitting");
      const html = renderRouter(router);
      expect(html).toContain('aria-busy="true"');
      expect(statusText(html)).toBe("Connecting to Stripe...");
    });
  });

  it("See a demo first goes to the read-only recovery demo, underlined and 24px tall", () => {
    const html = render(PAGE);
    const a = html.match(/<a[^>]*href="\/demos\/recovery"[^>]*>/);
    expect(a, "the demo link is on the page").not.toBeNull();
    expect(a![0]).toContain("underline");
    expect(a![0]).toContain("min-h-6");
    expect(text(html)).toContain("Read-only · Secure · Free · See a demo first");
  });

  it("without Stripe configured, no dead button is shown (RULES.md 2.7)", () => {
    const html = render({ ...PAGE, stripeEnabled: false });
    expect(html).not.toMatch(/<button/);
    expect(text(html)).toContain("Stripe Connect is not configured in this environment yet.");
  });
});

describe("J42 U1: refusals in a Capsomer alert, never naming an account, never echoing the URL", () => {
  const CODES = ["rate_limited", "cancelled", "invalid_state", "scope_refused", "failed", "session_expired"];

  for (const error of CODES) {
    it(`${error}: a role=alert Capsomer alert between the line and the box`, () => {
      const html = render({ ...PAGE, error });
      expect(tagWith(html, /cap-alert/)).toContain('role="alert"');
      const t = text(html);
      inOrder(t, ["We need read-only access", "What we can do"]);
      // No refusal names an account or its holder (RULES.md 4.14).
      expect(t).not.toMatch(/acct_|connected to|belongs to|held by/i);
    });
  }

  it("scope_refused is true for every grant the callback refuses, a null scope included", () => {
    // The callback refuses any scope that is not read_only, null included, so
    // "granted more access" was untrue for a grant with no scope (review round 1).
    const t = text(render({ ...PAGE, error: "scope_refused" }));
    expect(t).toContain("Stripe did not grant read-only access, so the run was refused. Nothing was read.");
    expect(t).not.toContain("more access");
  });

  it("an unknown code shows the fallback and never reflects the query string", () => {
    const hostile = '<img src=x onerror=alert(1)>acct_stranger owned by Dana';
    const html = render({ ...PAGE, error: hostile });
    expect(text(html)).toContain("Could not connect Stripe. Please try again.");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("acct_stranger");
    expect(html).not.toContain("Dana");
  });
});

describe("J42 U1: five text sizes, no amber, the Capsomer CSS loaded", () => {
  it("every text size on the page is one of the five", () => {
    for (const state of [PAGE, { ...PAGE, error: "failed" }, { ...PAGE, stripeEnabled: false }]) {
      for (const c of sizeClasses(render(state))) expect(FIVE_SIZES.has(c), c).toBe(true);
    }
  });

  it("no amber anywhere on the rendered page", () => {
    expect(render({ ...PAGE, error: "failed" })).not.toMatch(/amber/i);
  });

  it("the route loads the Capsomer CSS its parts read", () => {
    const src = readFileSync("app/routes/audit/connect.tsx", "utf8");
    for (const css of ["capsomer/panel.css", "capsomer/button.css", "capsomer/banner.css", "~/site-header.css"]) {
      expect(src).toContain(`import "${css}"`);
    }
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

  it("no state cookie at all: refused as invalid_state, and the code is never exchanged", async () => {
    const response = await call({ code: "ac_1", state: buildConnectState(AUDIT_ACTION) }, null);
    expectRefused(response, "invalid_state");
    expect(exchange.calls).toBe(0);
  });

  it("no state in the query: refused, never exchanged", async () => {
    const state = buildConnectState(AUDIT_ACTION);
    const response = await call({ code: "ac_1" }, state);
    expectRefused(response, "invalid_state");
    expect(exchange.calls).toBe(0);
  });

  it("a bare random state (Recova's shape) is refused: the state must be a minted pair", async () => {
    const bare = crypto.randomUUID();
    const response = await call({ code: "ac_1", state: bare }, bare);
    expectRefused(response, "invalid_state");
    expect(exchange.calls).toBe(0);
  });

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
