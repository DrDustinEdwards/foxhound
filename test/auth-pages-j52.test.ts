import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterContextProvider, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MIN_PASSWORD_LENGTH } from "~/lib/auth/password-policy";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { cloudflareContext } from "~/lib/cloudflare-context";

// J52 (job_674e728b50a3), rows A1 to A5: the auth layout and the four sign-in
// pages. Recova is the spec for content, layout and features, read whole at
// HEAD through Capsid repo "legacy":
//   app/(auth)/layout.tsx            blob 17a22006
//   components/SiteFooter.tsx        blob 673231c3
//   app/(auth)/login/page.tsx        blob ec09cd24
//   app/(auth)/signup/page.tsx       blob 08400b4d
//   app/(auth)/forgot-password/page.tsx  blob 56e454f3
//   app/(auth)/reset-password/page.tsx   blob f371f0bb
// Ruling 403 (Dustin "yes", 2026-09-19): no site navigation, and the footer
// reduced to Privacy and Terms. The parts are Capsomer's (Q12), teal (Q11), on
// the five text sizes (RULES.md 5.2).
//
// These read the RENDERED page, so a class on a helper that never reaches a
// reader cannot pass for one that does.

type AnyComponent = (props: never) => React.ReactNode;

const harness = vi.hoisted(() => ({ resetCalls: 0 }));

vi.mock("~/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth")>()),
  getAuth: () => ({
    api: {
      resetPassword: async () => {
        harness.resetCalls++;
        return new Response("{}", { status: 200 });
      },
    },
  }),
}));

vi.mock("~/lib/auth/session", () => ({ getSession: async () => null }));

// Imported so a missing layout fails an assertion below, not the whole file.
const AuthLayout = await import("~/layouts/auth").then(
  (m) => m.default as AnyComponent,
  () => null,
);
const { Footer } = await import("~/components/footer");
const login = await import("~/routes/auth/login");
const signup = await import("~/routes/auth/signup");
const forgot = await import("~/routes/auth/forgot-password");
const reset = await import("~/routes/auth/reset-password");

function render(Component: AnyComponent, loaderData: unknown, actionData?: unknown, path = "/"): string {
  const props = { loaderData, actionData, params: {}, matches: [] } as never;
  const element = createElement(Component as unknown as React.FC<object>, props);
  const router = createMemoryRouter([{ path: "*", element }], {
    initialEntries: [path],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

function renderLayout(): string {
  expect(AuthLayout, "app/layouts/auth.tsx exists").not.toBeNull();
  const router = createMemoryRouter(
    [{ path: "/", element: createElement(AuthLayout! as unknown as React.FC), children: [{ index: true, element: createElement("p", null, "PAGE") }] }],
    { initialEntries: ["/"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Source with comments removed, so a comment naming what is NOT used cannot
 *  read as a use. */
function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Visible text, tags stripped and whitespace collapsed, for order checks. */
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

const FIVE_SIZES = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
const NOT_A_SIZE =
  /^text-(text|text-secondary|text-tertiary|text-subtle|brand-text|chrome-text|chrome-text-secondary|chrome-brand|error-text|success-text|left|right|center)$/;

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

const SIGNUP_LINE = `We start recovering where Stripe's own retries stop. You pay ${RECOVERY_FEE_PERCENT}% of what we recover. Nothing until then.`;

const LOGIN = { googleEnabled: true, verified: false, error: null };
const SIGNUP = { googleEnabled: true };
const RESET = { token: "tok_123" };

const ALL_PAGES: [string, AnyComponent, unknown, unknown?][] = [
  ["login", login.default as AnyComponent, LOGIN],
  ["login, error", login.default as AnyComponent, LOGIN, { error: "Invalid email or password" }],
  ["signup", signup.default as AnyComponent, SIGNUP],
  ["signup, sent", signup.default as AnyComponent, SIGNUP, { ok: true, email: "a@example.com", error: null }],
  ["forgot", forgot.default as AnyComponent, undefined],
  ["forgot, sent", forgot.default as AnyComponent, undefined, { ok: true, email: "a@example.com", error: null }],
  ["reset", reset.default as AnyComponent, RESET],
  ["reset, done", reset.default as AnyComponent, RESET, { ok: true, error: null }],
];

describe("A1: Recova's bare auth layout (ruling 403)", () => {
  it("the four pages sit in the auth layout, not the marketing one", () => {
    const routes = readFileSync("app/routes.ts", "utf8");
    const authBlock = routes.match(/layout\("\.\/layouts\/auth\.tsx",\s*\[([\s\S]*?)\]\)/);
    expect(authBlock, "an auth layout block in routes.ts").not.toBeNull();
    for (const f of ["login", "signup", "forgot-password", "reset-password"]) {
      expect(authBlock![1]).toContain(`"./routes/auth/${f}.tsx"`);
    }
    const marketing = routes.match(/layout\("\.\/layouts\/marketing\.tsx",\s*\[([\s\S]*?)\n {2}\]\),/);
    expect(marketing).not.toBeNull();
    for (const f of ["login", "signup", "forgot-password", "reset-password"]) {
      expect(marketing![1]).not.toContain(`"./routes/auth/${f}.tsx"`);
    }
  });

  it("no site navigation: no header, no nav, one main holding the page, then the footer", () => {
    const html = renderLayout();
    expect(html).not.toMatch(/<header[\s>]/);
    expect(html).not.toMatch(/<nav[\s>]/);
    expect(html.match(/<main[\s>]/g)).toHaveLength(1);
    inOrder(html, ["<main", "PAGE", "</main>", "<footer"]);
  });

  it("the footer is reduced to its bottom row with Privacy and Terms (SiteFooter variant auth)", () => {
    const html = renderLayout();
    const footer = html.slice(html.indexOf("<footer"));
    expect(footer).toMatch(/<a[^>]*href="\/privacy"[^>]*>Privacy<\/a>/);
    expect(footer).toMatch(/<a[^>]*href="\/terms"[^>]*>Terms<\/a>/);
    // No link columns: those are the marketing variant's.
    expect(text(footer)).not.toContain("Product");
    expect(text(footer)).not.toContain("Resources");
    expect(footer).not.toContain('href="/security"');
    // No home-linked logo: Recova's auth layout and bottom row have none (the
    // mark is an image, not a link). Ruling 403 binding 2: ask, never add.
    expect(footer).not.toMatch(/<a[^>]*href="\/"/);
    inOrder(text(footer), ["© 2026 Foxhound", "Privacy", "Terms"]);
  });

  it("the footer links are teal on hover, never amber, and 24px tall as targets", () => {
    const html = renderToStaticMarkup(
      createElement(RouterProvider, {
        router: createMemoryRouter([{ path: "*", element: createElement(() => Footer({ variant: "auth" })) }]),
      }),
    );
    for (const label of ["Privacy", "Terms"]) {
      const tag = html.match(new RegExp(`<a[^>]*>${label}</a>`))![0];
      expect(tag).toContain("hover:text-chrome-brand");
      expect(tag).toContain("min-h-6");
      expect(tag).not.toMatch(/amber/);
    }
  });

  it("the marketing and app footers do not gain the auth links", () => {
    for (const variant of ["marketing", "app"] as const) {
      const html = renderToStaticMarkup(
        createElement(RouterProvider, {
          router: createMemoryRouter([{ path: "*", element: createElement(() => Footer({ variant })) }]),
        }),
      );
      const row = html.slice(html.lastIndexOf("h-14"));
      expect(row, variant).not.toContain('href="/privacy"');
    }
  });
});

describe("every page: one card from Capsomer's parts, on the five sizes, teal", () => {
  it.each(ALL_PAGES)("%s: Recova's centred 400px card is a Capsomer panel in the teal family", (_n, C, ld, ad) => {
    const html = render(C, ld, ad);
    expect(html).toContain("max-w-[400px]");
    expect(html).toMatch(/class="fh-cap[^"]*"[^>]*data-family="teal"/);
    expect(html).toMatch(/<section class="cap-panel"><div class="cap-panel-body">/);
    expect(html).toContain("min-h-screen");
  });

  it.each(ALL_PAGES)("%s: no brand panel, no second main, one h1", (_n, C, ld, ad) => {
    const html = render(C, ld, ad);
    expect(html).not.toContain("Outcome-based recovery for Stripe merchants.");
    expect(html).not.toContain("max-w-5xl");
    expect(html).not.toMatch(/<main[\s>]/);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it.each(ALL_PAGES)("%s: text uses only the five sizes", (_n, C, ld, ad) => {
    const sizes = sizeClasses(render(C, ld, ad));
    expect(sizes.filter((s) => !FIVE_SIZES.has(s))).toEqual([]);
  });

  it.each(ALL_PAGES)("%s: no amber anywhere (Q11)", (_n, C, ld, ad) => {
    expect(render(C, ld, ad)).not.toMatch(/amber/i);
  });

  it("every input is a Capsomer input inside a Capsomer field, with a label tied to it", () => {
    for (const [n, C, ld, ad] of ALL_PAGES) {
      const html = render(C, ld, ad);
      for (const m of html.matchAll(/<input(?![^>]*type="hidden")[^>]*>/g)) {
        const tag = m[0];
        expect(tag, n).toContain('class="cap-input"');
        const id = tag.match(/id="([^"]+)"/)?.[1];
        expect(id, `${n}: input has an id`).toBeTruthy();
        expect(html, `${n}: a label for ${id}`).toMatch(new RegExp(`<label class="cap-field-label" for="${id}"`));
      }
    }
  });

  it("the submit button is Capsomer's primary button, full width", () => {
    for (const [n, C, ld, ad] of ALL_PAGES) {
      const html = render(C, ld, ad);
      const submit = html.match(/<button[^>]*type="submit"[^>]*class="[^"]*cap-btn[^"]*"[^>]*>|<button[^>]*class="[^"]*cap-btn[^"]*"[^>]*type="submit"[^>]*>/g) ?? [];
      if (!html.includes("<form")) continue;
      expect(submit.some((t) => t.includes('data-variant="primary"')), n).toBe(true);
    }
  });
});

describe("A2 /login: Recova's page", () => {
  it("Recova's content in Recova's order, with Foxhound's name", () => {
    inOrder(text(render(login.default as AnyComponent, LOGIN)), [
      "Welcome back",
      "Log in to your Foxhound account",
      "Continue with Google",
      "or",
      "Email",
      "Password",
      "Forgot password?",
      "Log in",
      "Don't have an account?",
      "Connect Stripe",
    ]);
  });

  it("links: forgot password on the password row, Connect Stripe to /signup", () => {
    const html = render(login.default as AnyComponent, LOGIN);
    expect(html).toMatch(/<a[^>]*href="\/forgot-password"[^>]*>Forgot password\?<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/signup"[^>]*>Connect Stripe<\/a>/);
  });

  it("the Google button posts to Foxhound's own start route, with Google's mark, and only when Google is set up", () => {
    const on = render(login.default as AnyComponent, LOGIN);
    expect(on).toMatch(/<form[^>]*action="\/auth\/google"[^>]*method="post"/);
    expect(on).toMatch(/<img[^>]*src="\/google-g\.svg"[^>]*alt=""/);
    const off = text(render(login.default as AnyComponent, { googleEnabled: false, verified: false, error: null }));
    expect(off).not.toContain("Continue with Google");
    expect(off).not.toMatch(/\bor\b/);
  });

  it("the fields carry autocomplete for a password manager", () => {
    const html = render(login.default as AnyComponent, LOGIN);
    expect(html).toMatch(/<input[^>]*name="email"[^>]*type="email"[^>]*autoComplete="email"|<input[^>]*type="email"[^>]*name="email"/i);
    expect(html).toMatch(/autoComplete="current-password"/i);
  });

  it("an error shows in Recova's alert, announced", () => {
    const html = render(login.default as AnyComponent, LOGIN, { error: "Too many attempts. Please try again in a minute." });
    expect(html).toMatch(/role="alert"[\s\S]*Too many attempts\. Please try again in a minute\./);
    inOrder(text(html), ["Forgot password?", "Too many attempts", "Log in"]);
  });

  it("a refused Google start comes back with Recova's ?error= mechanism and the sign-in limit's words", async () => {
    const ctx = new RouterContextProvider();
    ctx.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" });
    const ld = await login.loader({
      request: new Request("https://foxhoundapp.com/login?error=rate_limited"),
      context: ctx,
      params: {},
    } as never);
    expect(ld.error).toBe("Too many attempts. Please try again in a minute.");
    const html = render(login.default as AnyComponent, ld);
    expect(html).toMatch(/role="alert"[\s\S]*Too many attempts/);
    const unknown = await login.loader({
      request: new Request("https://foxhoundapp.com/login?error=%3Cscript%3E"),
      context: ctx,
      params: {},
    } as never);
    expect(unknown.error).toBeNull();
  });

  it("keeps Foxhound's verified notice (its engine verifies email before sign-in)", () => {
    const html = render(login.default as AnyComponent, { googleEnabled: false, verified: true, error: null });
    expect(text(html)).toContain("Your email is verified. You can sign in now.");
  });

  it("the page title says Log in, Recova's word", () => {
    expect(login.meta()).toEqual([{ title: "Log in - Foxhound" }]);
  });
});

describe("A3 /signup: Recova's page", () => {
  it("the line under the heading is true against the engine: no 'immediately' (RULES.md 3.3)", () => {
    // Review round 1. The first soft failure is parked as stripe_retrying and
    // Foxhound's sequence starts when Stripe's own retries stop; hard declines
    // start at once. "We start recovering immediately" promised neither.
    const html = text(render(signup.default as AnyComponent, SIGNUP));
    expect(html).toContain(SIGNUP_LINE);
    expect(html).not.toMatch(/immediately/i);
    expect(code("app/routes/auth/signup.tsx")).not.toMatch(/immediately/i);
  });

  it("Recova's heading and line, the fee read from Foxhound's own constant", () => {
    expect(RECOVERY_FEE_PERCENT).toBe(20);
    inOrder(text(render(signup.default as AnyComponent, SIGNUP)), [
      "Connect Stripe once",
      SIGNUP_LINE,
      "Continue with Google",
      "or",
      "Email",
      `Password (min ${MIN_PASSWORD_LENGTH} characters)`,
      "Sign up",
      "Already have an account?",
      "Log in",
    ]);
  });

  it("no Name field: Recova's signup asks for email and password only", () => {
    const html = render(signup.default as AnyComponent, SIGNUP);
    expect(html).not.toMatch(/name="name"/);
    expect(text(html)).not.toMatch(/\bName\b/);
  });

  it("the minimum length is Foxhound's own (12), not Recova's 8", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(text(render(signup.default as AnyComponent, SIGNUP))).not.toContain("min 8 characters");
    expect(render(signup.default as AnyComponent, SIGNUP)).toMatch(/autoComplete="new-password"/i);
  });

  it("Log in links to /login", () => {
    expect(render(signup.default as AnyComponent, SIGNUP)).toMatch(/<a[^>]*href="\/login"[^>]*>Log in<\/a>/);
  });

  it("no Turnstile widget: Recova has none, and none is recorded for signup", () => {
    expect(code("app/routes/auth/signup.tsx")).not.toMatch(/turnstile/i);
  });

  it("after signup, the check-your-email state names the address", () => {
    const t = text(render(signup.default as AnyComponent, SIGNUP, { ok: true, email: "a@example.com", error: null }));
    expect(t).toContain("Check your email");
    expect(t).toContain("a@example.com");
  });
});

describe("A4 /forgot-password: Recova's page", () => {
  it("Recova's content in Recova's order", () => {
    const html = render(forgot.default as AnyComponent, undefined);
    inOrder(text(html), [
      "Reset your password",
      "Enter your email and we'll send you a reset link",
      "Email",
      "Send reset link",
      "← Back to login",
    ]);
    expect(html).toContain('placeholder="you@yourapp.com"');
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>← Back to login<\/a>/);
  });

  it("the sent state: Recova's heading, the address in bold, and the way back, without saying an account exists", () => {
    const html = render(forgot.default as AnyComponent, undefined, { ok: true, email: "a@example.com", error: null });
    inOrder(text(html), ["Check your email", "a@example.com", "Check your inbox and click the link to reset your password.", "← Back to login"]);
    expect(html).toMatch(/<strong[^>]*>a@example\.com<\/strong>/);
    // Recova said "We sent a password reset link to" every address. Foxhound
    // never says whether an account exists, so that sentence would be untrue
    // for an unknown address.
    expect(text(html)).toContain("If an account exists for");
    expect(text(html)).not.toMatch(/We sent a password reset link to a@/);
  });
});

describe("A5 /reset-password: Recova's page", () => {
  it("Recova's content in Recova's order, two password fields", () => {
    const html = render(reset.default as AnyComponent, RESET);
    inOrder(text(html), [
      "Set new password",
      "Choose a strong password for your account",
      "New password",
      "Confirm password",
      "Update password",
    ]);
    expect(html).toContain(`placeholder="At least ${MIN_PASSWORD_LENGTH} characters"`);
    expect(html).toContain('placeholder="Repeat your password"');
    expect(html).toMatch(/<input type="hidden" name="token" value="tok_123"\/>/);
  });

  describe("the action checks the two passwords before Better Auth sees them", () => {
    beforeEach(() => {
      harness.resetCalls = 0;
    });

    async function act(fields: Record<string, string>) {
      const ctx = new RouterContextProvider();
      ctx.set(cloudflareContext, { env: {} as Env, ctx: {} as ExecutionContext, nonce: "n" });
      const request = new Request("https://foxhoundapp.com/reset-password", {
        method: "POST",
        body: new URLSearchParams(fields),
      });
      const out = (await reset.action({ request, context: ctx, params: {} } as never)) as {
        data?: { error: string | null; ok: boolean };
        init?: ResponseInit;
      };
      return out;
    }

    it("checks the token before the two passwords (review round 1)", async () => {
      const out = await act({ token: "", password: "short", confirm: "different" });
      expect(out.data?.error).toBe("This reset link is invalid or expired.");
      expect(out.init?.status).toBe(400);
      expect(harness.resetCalls).toBe(0);
    });

    it("refuses two passwords that differ, in Recova's words", async () => {
      const out = await act({ token: "t", password: "a-long-password-1", confirm: "a-long-password-2" });
      expect(out.data?.error).toBe("Passwords do not match");
      expect(out.init?.status).toBe(400);
      expect(harness.resetCalls).toBe(0);
    });

    it("refuses a short password with Foxhound's minimum", async () => {
      const out = await act({ token: "t", password: "short", confirm: "short" });
      expect(out.data?.error).toBe(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      expect(harness.resetCalls).toBe(0);
    });

    it("passes a matching, long enough password to Better Auth", async () => {
      const out = await act({ token: "t", password: "a-long-password-1", confirm: "a-long-password-1" });
      expect(out.data?.ok).toBe(true);
      expect(harness.resetCalls).toBe(1);
    });
  });
});

describe("review round 1: each input is tied to the error it caused", () => {
  const ERRORED: [string, AnyComponent, unknown, unknown, string[]][] = [
    ["login", login.default as AnyComponent, LOGIN, { error: "Invalid email or password" }, ["login-email", "login-password"]],
    [
      "signup",
      signup.default as AnyComponent,
      SIGNUP,
      { ok: false, email: null, error: "Too many requests. Please try again later." },
      ["signup-email", "signup-password"],
    ],
    [
      "forgot",
      forgot.default as AnyComponent,
      undefined,
      { ok: false, email: null, error: "Too many attempts. Please try again in a minute." },
      ["forgot-email"],
    ],
    ["reset", reset.default as AnyComponent, RESET, { ok: false, error: "Passwords do not match" }, ["reset-password", "reset-confirm"]],
  ];

  for (const [name, Page, loaderData, actionData, inputs] of ERRORED) {
    it(`${name}: with an error, each input is aria-invalid and described by the alert that holds it`, () => {
      const html = render(Page, loaderData, actionData);
      const err = (actionData as { error: string }).error;
      for (const id of inputs) {
        const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
        expect(tag, `input #${id}`).toBeDefined();
        expect(tag).toContain('aria-invalid="true"');
        const describedBy = tag!.match(/aria-describedby="([^"]+)"/)?.[1];
        expect(describedBy, `#${id} aria-describedby`).toBeDefined();
        const target = html.match(new RegExp(`id="${describedBy}"[^>]*>([\\s\\S]*?)</div>`))?.[1] ?? "";
        expect(text(target)).toContain(err);
      }
    });

    it(`${name}: with no error, no input claims to be invalid`, () => {
      const html = render(Page, loaderData);
      expect(html).not.toContain("aria-invalid");
      expect(html).not.toContain("aria-describedby");
    });
  }
});

describe("Foxhound's engine is kept, Recova's is not copied", () => {
  it("no Supabase anywhere in the four pages or the layout", () => {
    for (const f of [
      "app/layouts/auth.tsx",
      "app/routes/auth/login.tsx",
      "app/routes/auth/signup.tsx",
      "app/routes/auth/forgot-password.tsx",
      "app/routes/auth/reset-password.tsx",
    ]) {
      expect(code(f), f).not.toMatch(/supabase/i);
    }
  });

  it("each page still calls Better Auth's own method", () => {
    expect(readFileSync("app/routes/auth/login.tsx", "utf8")).toContain("api.signInEmail(");
    expect(readFileSync("app/routes/auth/signup.tsx", "utf8")).toContain("api.signUpEmail(");
    expect(readFileSync("app/routes/auth/forgot-password.tsx", "utf8")).toContain("api.requestPasswordReset(");
    expect(readFileSync("app/routes/auth/reset-password.tsx", "utf8")).toContain("api.resetPassword(");
  });
});
