import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { CONSENT_CAPABILITIES } from "~/lib/oauth/consent-copy";

const { default: Authorize } = await import("~/routes/oauth/authorize");

// J79, row A9: the consent page, rendered. Recova is the spec for its content
// and layout (app/oauth/authorize/page.tsx 63884241 and ConsentButtons.tsx
// eb31e8e9, read whole): one 460px card centred on a full-height page with no
// site navigation (Recova's root layout has none), the wordmark, the h1 naming
// the client, the line under it, the account box, what the client can do, the
// error, Allow access and Deny side by side, and the closing line. The parts
// are Capsomer's (Q12), teal (Q11), on the five text sizes (RULES.md 5.2).

type Props = Parameters<typeof Authorize>[0];
type LoaderData = Props["loaderData"];

const OK: LoaderData = {
  ok: true,
  clientId: "c1",
  clientName: "Claude",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  state: "st",
  codeChallenge: "x".repeat(43),
  accountName: "Acme Supply Co.",
  email: "dana@acme.test",
};

function render(loaderData: LoaderData, actionData?: { error: string }): string {
  const props = { loaderData, actionData, params: {}, matches: [] } as unknown as Props;
  const router = createMemoryRouter([{ path: "*", element: createElement(Authorize, props) }], {
    initialEntries: ["/oauth/authorize"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function inOrder(haystack: string, needles: string[]) {
  let from = -1;
  for (const n of needles) {
    const i = haystack.indexOf(n, from + 1);
    expect(i, `"${n}" appears after the item before it`).toBeGreaterThan(from);
    from = i;
  }
}

const NOT_A_SIZE =
  /^text-(text|text-secondary|text-tertiary|text-subtle|brand-text|wordmark|error-text|left|right|center)$/;

describe("A9: Recova's card, in Recova's order", () => {
  it("reads as Recova's page, with Foxhound's name", () => {
    // The wordmark renders as fo<span>x</span>hound, so its text reads
    // "fo x hound" once tags are stripped.
    inOrder(text(render(OK)), [
      "fo x hound",
      "Claude wants to connect to your Foxhound account",
      "Approving grants access to the account below. You can revoke it any time from Settings.",
      "Account",
      "Acme Supply Co.",
      "dana@acme.test",
      "What Claude can do",
      ...CONSENT_CAPABILITIES.map((c) => c.text),
      "Allow access",
      "Deny",
      "Foxhound never shares your Stripe access token with third-party clients.",
    ]);
  });

  it("is one 460px card, centred on a full-height page, with no site navigation", () => {
    const html = render(OK);
    expect(html).toMatch(/class="[^"]*min-h-screen[^"]*items-center[^"]*justify-center/);
    expect(html).toMatch(/class="[^"]*max-w-\[460px\]/);
    expect(html).not.toMatch(/<nav|<header/);
    expect(readFileSync("app/routes.ts", "utf8")).toMatch(/^ {2}route\("oauth\/authorize", "\.\/routes\/oauth\/authorize\.tsx"\),$/m);
  });

  it("has exactly one h1, and the capabilities are a list labelled by their heading", () => {
    const html = render(OK);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<ul[^>]*aria-labelledby="oauth-can"/);
    expect(html).toMatch(/id="oauth-can"/);
  });

  it("Allow is Capsomer's primary button and Deny its secondary, both submitting the one form", () => {
    const html = render(OK);
    const allow = html.match(/<button[^>]*value="allow"[^>]*>/)?.[0] ?? "";
    const deny = html.match(/<button[^>]*value="deny"[^>]*>/)?.[0] ?? "";
    expect(allow).toMatch(/cap-btn/);
    expect(allow).toMatch(/data-variant="primary"|cap-btn-primary/);
    expect(deny).toMatch(/cap-btn/);
    expect(allow).toMatch(/type="submit"/);
    expect(deny).toMatch(/type="submit"/);
    expect(html).toMatch(/<form[^>]*method="post"/);
    for (const field of ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type"]) {
      expect(html, field).toMatch(new RegExp(`<input type="hidden" name="${field}"`));
    }
  });

  it("offers no scope selector: Foxhound issues the merchant scope only", () => {
    const html = render(OK);
    expect(html).not.toMatch(/All accounts|Scope/);
  });

  it("shows an error in an alert above the buttons", () => {
    const html = render(OK, { error: "This request is no longer valid." });
    expect(html).toMatch(/role="alert"/);
    inOrder(text(html), ["What Claude can do", "This request is no longer valid.", "Allow access"]);
  });

  it("a refused request is the same card with Recova's title and message", () => {
    const html = render({ ok: false, title: "Unknown client", message: "This client is not registered with Foxhound." });
    expect(text(html)).toBe("Unknown client This client is not registered with Foxhound.");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("uses only the five text sizes and Foxhound's teal family", () => {
    const html = render(OK);
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (!base.startsWith("text-") || NOT_A_SIZE.test(base)) continue;
        expect(["text-display", "text-title", "text-body", "text-label", "text-micro"], base).toContain(base);
      }
    }
    expect(html).toMatch(/data-family="teal"/);
  });
});
