
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterContextProvider, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MIN_PASSWORD_LENGTH } from "~/lib/auth/password-policy";
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




const SIGNUP = { googleEnabled: true };


describe("A3 /signup: Recova's page", () => {

  it("the minimum length is Foxhound's own (12), not Recova's 8", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(text(render(signup.default as AnyComponent, SIGNUP))).not.toContain("min 8 characters");
    expect(render(signup.default as AnyComponent, SIGNUP)).toMatch(/autoComplete="new-password"/i);
  });
});

describe("A4 /forgot-password: Recova's page", () => {

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
