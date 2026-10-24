
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterContextProvider, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { safeNextPath } from "~/lib/auth/next-path";

// J79, ruling 8's inherited artifacts on the sign-in side. The authorize page
// sends a signed-out visitor to /login?next=<the whole authorize URL>; Recova's
// login page (app/(auth)/login/page.tsx, ec09cd24) honoured next= through
// validateRedirect, and its Google button carried it through the provider
// round trip in a pending_redirect cookie that app/auth/callback/route.ts
// (7cb52c7b) validated and burned. Foxhound's Google sign-in is Better Auth's,
// whose callbackURL rides in its own one-time OAuth state, so the validated
// path goes there instead of a cookie. The emailed sign-in link carries it
// through the passkey offer (/passkey?next=), which goes on to it.

const harness = vi.hoisted(() => ({
  session: null as unknown,
  signInSocial: vi.fn(),
  handler: vi.fn(),
}));

vi.mock("~/lib/auth/session", () => ({ getSession: async () => harness.session }));
vi.mock("~/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth")>()),
  getAuth: async () => ({ api: { signInSocial: harness.signInSocial }, handler: harness.handler }),
}));
vi.mock("~/lib/auth/rate-limit.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth/rate-limit.server")>()),
  checkAuthLimit: async () => null,
}));

const login = await import("~/routes/auth/login");
const socialStart = await import("~/routes/auth/social-start");

const ORIGIN = "https://foxhoundapp.test";
const AUTHORIZE =
  "/oauth/authorize?client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&resource=https%3A%2F%2Ffoxhoundapp.test%2Fmcp&state=s";

function context(): RouterContextProvider {
  const ctx = new RouterContextProvider();
  ctx.set(cloudflareContext, {
    env: { BETTER_AUTH_URL: ORIGIN, GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" } as unknown as Env,
    ctx: {} as ExecutionContext,
    nonce: "",
  });
  return ctx;
}

beforeEach(() => {
  harness.session = null;
  harness.signInSocial.mockReset();
  harness.handler.mockReset();
});

describe("safeNextPath: Recova's validateRedirect, every check anchored at position 0", () => {

  it("refuses absolute, protocol-relative and backslash targets", () => {
    for (const bad of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "evil", "", null, undefined, "/\t/evil.example", "/\n/evil.example", "%2F%09%2Fevil.example"]) {
      expect(safeNextPath(bad), String(bad)).toBe("/console");
    }
  });

  it("decodes a doubly encoded value once, as Recova's tryDecode did", () => {
    expect(safeNextPath(encodeURIComponent("/oauth/authorize?a=1"))).toBe("/oauth/authorize?a=1");
    expect(safeNextPath(encodeURIComponent("//evil.example"))).toBe("/console");
  });
});

describe("/login carries next= through both ways of signing in", () => {
  it("a signed-in visitor is sent straight to next", async () => {
    harness.session = { user: { id: "u" }, session: {} };
    let thrown: unknown;
    try {
      await login.loader({
        request: new Request(`${ORIGIN}/login?next=${encodeURIComponent(AUTHORIZE)}`),
        context: context(),
        params: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Response).headers.get("Location")).toBe(AUTHORIZE);
  });

  it("an emailed link goes on to next through the passkey offer, and a foreign next to /console", async () => {
    harness.handler.mockImplementation(async () => new Response("{}", { status: 200 }));
    for (const [next, expected] of [
      [AUTHORIZE, AUTHORIZE],
      ["https://evil.example/", "/console"],
    ]) {
      harness.handler.mockClear();
      const form = new URLSearchParams({ email: "dana@acme.test", next });
      await login.action({
        request: new Request(`${ORIGIN}/login`, { method: "POST", body: form }),
        context: context(),
        params: {},
      } as never);
      const sent = harness.handler.mock.calls[0][0] as Request;
      const { callbackURL } = (await sent.json()) as { callbackURL: string };
      expect(callbackURL, next).toBe(`${ORIGIN}/passkey?next=${encodeURIComponent(expected)}`);
    }
  });

  it("the Google start sends the validated next to Better Auth as an absolute same-site URL", async () => {
    harness.signInSocial.mockImplementation(async () => new Response(JSON.stringify({ url: "https://accounts.google.com/x" })));
    const form = new URLSearchParams({ next: AUTHORIZE });
    await socialStart.action({
      request: new Request(`${ORIGIN}/auth/google`, { method: "POST", body: form }),
      context: context(),
      params: { provider: "google" },
    } as never);
    expect(harness.signInSocial.mock.calls[0][0].body.callbackURL).toBe(`${ORIGIN}${AUTHORIZE}`);

    harness.signInSocial.mockClear();
    await socialStart.action({
      request: new Request(`${ORIGIN}/auth/google`, { method: "POST", body: new URLSearchParams({ next: "//evil.example" }) }),
      context: context(),
      params: { provider: "google" },
    } as never);
    expect(harness.signInSocial.mock.calls[0][0].body.callbackURL).toBe(`${ORIGIN}/console`);
  });

  function renderLogin(next: string): string {
    const Login = login.default;
    const props = {
      loaderData: { methods: { google: true, apple: false, turnstileSiteKey: null }, error: null, next },
      params: {},
      matches: [],
    } as unknown as Parameters<typeof Login>[0];
    const router = createMemoryRouter([{ path: "*", element: createElement(Login, props) }], {
      initialEntries: ["/login"],
    });
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  }

  it("the page puts next in both forms, so neither path drops it", () => {
    const hidden = renderLogin(AUTHORIZE).match(/<input type="hidden" name="next" value="[^"]*"\/>/g) ?? [];
    expect(hidden).toHaveLength(2);
    expect(hidden[0]).toContain("/oauth/authorize?client_id=c1&amp;");
  });

  it("the plain page adds no hidden field when there is no next", () => {
    expect(renderLogin("/console")).not.toContain('name="next"');
  });

  it("a signed-out visitor's page is given the validated next", async () => {
    const data = (await login.loader({
      request: new Request(`${ORIGIN}/login?next=${encodeURIComponent(AUTHORIZE)}`),
      context: context(),
      params: {},
    } as never)) as { next: string };
    expect(data.next).toBe(AUTHORIZE);
  });
});
