import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import CardUpdate from "~/routes/utility/card-update";

// J62 (job_323ed2a2f37e), row F8: the hosted card update page at /p/:token,
// built from Capsomer's parts (Q12), teal (Q11) and on the five text sizes
// (RULES.md 5.2), keeping Foxhound's own Checkout flow.
//
// Recova has no page here: its dunning, expiring-card and win-back emails link
// straight to a Stripe billing portal session (lib/recovery-execution.ts blob
// 3a8f8768 lines 208 to 233; app/api/cron/expiring-cards/route.ts line 201;
// app/api/cron/process-winback/route.ts line 313). Foxhound's page is the
// approved difference (APPROVED-DIFFERENCES, expiring-card and win-back lines,
// 2026-09-19), so its words are Foxhound's own and are pinned here unchanged:
// this job moves the parts, never the copy.
//
// These read the RENDERED page, so a class on a helper that never reaches a
// reader cannot pass for one that does.

type Props = Parameters<typeof CardUpdate>[0];
type LoaderData = Props["loaderData"];

function render(loaderData: LoaderData, actionData?: { error: string }): string {
  const props = { loaderData, actionData, params: { token: "t" }, matches: [] } as unknown as Props;
  const router = createMemoryRouter([{ path: "*", element: createElement(CardUpdate, props) }], {
    initialEntries: ["/p/t"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** The page's own content: its main landmark, below the site header. */
function body(html: string): string {
  const i = html.indexOf("<main");
  expect(i, "the page's main landmark is on the page").toBeGreaterThan(-1);
  return html.slice(i);
}

/** The opening tag of the first element carrying `cls`, so attributes can be read off it. */
function tagWith(html: string, cls: RegExp): string {
  const m = html.match(new RegExp(`<[a-z]+[^>]*class="[^"]*${cls.source}[^"]*"[^>]*>`));
  expect(m, `an element with ${cls.source} is on the page`).not.toBeNull();
  return m![0];
}

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

const READY: LoaderData = { state: "ready", amountCents: 9900, currency: "usd" };
const RESUBSCRIBE: LoaderData = { state: "resubscribe", planName: "Pro" };

describe("J62: the one action is Capsomer's primary Button", () => {
  it("recovery mode submits through a cap-btn primary, labelled as before", () => {
    const html = body(render(READY));
    const btn = tagWith(html, /cap-btn/);
    expect(btn).toMatch(/^<button/);
    expect(btn).toContain('type="submit"');
    expect(btn).toContain('data-variant="primary"');
    expect(html).toMatch(/<button[^>]*>Update payment method<\/button>/);
  });

  it("resubscribe mode submits through a cap-btn primary, labelled as before", () => {
    const html = body(render(RESUBSCRIBE));
    const btn = tagWith(html, /cap-btn/);
    expect(btn).toContain('type="submit"');
    expect(btn).toContain('data-variant="primary"');
    expect(html).toMatch(/<button[^>]*>Reactivate my account<\/button>/);
  });

  it("no hand-rolled button is left: the old local Submit's fill class is gone", () => {
    for (const state of [READY, RESUBSCRIBE]) {
      expect(body(render(state))).not.toMatch(/bg-brand/);
    }
  });

  it("there is exactly one button and one form on the page body", () => {
    for (const state of [READY, RESUBSCRIBE]) {
      const html = body(render(state));
      expect(html.match(/<button/g)?.length).toBe(1);
      expect(html.match(/<form/g)?.length).toBe(1);
      expect(html).toMatch(/<form[^>]*method="post"/);
    }
  });
});

describe("J62: notices are Capsomer's Banner and Alert, in the right tone and role", () => {
  const OK_STATES: [LoaderData, string, string][] = [
    [{ state: "resolved" }, "Nothing to do here", "This payment has already been resolved. No action is needed."],
    [{ state: "done" }, "Payment method updated", "Your payment method has been updated. Thank you."],
    [{ state: "handled" }, "Nothing to do here", "This subscription has already been reactivated. No action is needed."],
    [{ state: "resubscribed" }, "Welcome back", "Your subscription has been restarted. Thank you."],
  ];

  for (const [data, title, text] of OK_STATES) {
    it(`${data.state}: an ok banner (role status) with the same title and words`, () => {
      const page = render(data);
      expect(page).toContain(`>${title}</h1>`);
      const html = body(page);
      const banner = tagWith(html, /cap-banner/);
      expect(banner).toContain('data-tone="ok"');
      expect(banner).toContain('role="status"');
      expect(html).toContain(text);
      expect(html).not.toMatch(/<button/);
    });
  }

  it("invalid: a critical banner (role alert) with the same title and words", () => {
    const page = render({ state: "invalid" });
    expect(page).toContain(">Link not found</h1>");
    const html = body(page);
    const banner = tagWith(html, /cap-banner/);
    expect(banner).toContain('data-tone="crit"');
    expect(banner).toContain('role="alert"');
    expect(html).toContain("This link is invalid or has expired.");
    expect(html).not.toMatch(/<button/);
  });

  it("setup_failed: a critical alert beside the button it is about, then the button again", () => {
    const html = body(render({ state: "setup_failed" }));
    const alert = tagWith(html, /cap-alert/);
    expect(alert).toContain('data-tone="crit"');
    expect(alert).toContain('role="alert"');
    expect(html).toContain("We could not confirm your payment method update. Please try again.");
    expect(html.indexOf("cap-alert")).toBeLessThan(html.indexOf("<form"));
    expect(html).toMatch(/<button[^>]*>Update payment method<\/button>/);
  });

  it("an action error is a critical alert above the button, in both modes", () => {
    for (const state of [READY, RESUBSCRIBE]) {
      const html = body(render(state, { error: "Could not start the payment method update. Please try again." }));
      const alert = tagWith(html, /cap-alert/);
      expect(alert).toContain('data-tone="crit"');
      expect(alert).toContain('role="alert"');
      expect(html).toContain("Could not start the payment method update. Please try again.");
      expect(html.indexOf("cap-alert")).toBeLessThan(html.indexOf("<form"));
    }
  });

  it("the old local Alert's classes are gone from every state", () => {
    const states: LoaderData[] = [
      READY,
      RESUBSCRIBE,
      { state: "invalid" },
      { state: "resolved" },
      { state: "done" },
      { state: "handled" },
      { state: "resubscribed" },
      { state: "setup_failed" },
    ];
    for (const s of states) {
      const html = body(render(s, { error: "x" }));
      expect(html, s.state).not.toMatch(/bg-red-bg|bg-green-bg|text-error-text|text-success-text/);
    }
  });
});

describe("J62: teal throughout and the five text sizes", () => {
  it("the page's parts sit in Capsomer's teal family with Foxhound's neutrals, focus ring teal", () => {
    const html = render(READY);
    const marker = html.indexOf('data-card-update=""');
    expect(marker, "the card update body wrapper is on the page").toBeGreaterThan(-1);
    const wrap = html.slice(html.lastIndexOf("<div", marker));
    const open = wrap.slice(0, wrap.indexOf(">") + 1);
    expect(open).toContain('data-family="teal"');
    expect(open).toMatch(/class="[^"]*\bfh-cap\b/);
    expect(open).toContain("[--border-focus:var(--ring)]");
  });

  it("no amber anywhere on the rendered page, in any state", () => {
    for (const s of [READY, RESUBSCRIBE, { state: "invalid" } as LoaderData, { state: "done" } as LoaderData]) {
      expect(render(s, { error: "x" })).not.toMatch(/amber/i);
    }
  });

  // From the page's own heading on: the frame's brand panel before it (the
  // wordmark logo) is AuthShell's, shared with the sign-in pages, not this row.
  it("every text size from the page's heading on is one of the five", () => {
    for (const s of [READY, RESUBSCRIBE, { state: "setup_failed" } as LoaderData]) {
      const html = body(render(s, { error: "x" }));
      const sizes = sizeClasses(html.slice(html.lastIndexOf("<div", html.indexOf("<h1"))));
      for (const c of sizes) expect(FIVE_SIZES.has(c), c).toBe(true);
    }
  });

  it("the route loads the Capsomer CSS its parts read: tokens, teal family, button and banner", () => {
    const src = readFileSync("app/routes/utility/card-update.tsx", "utf8");
    expect(src).toMatch(/import "capsomer\/button\.css";/);
    expect(src).toMatch(/import "capsomer\/banner\.css";/);
    expect(src).toMatch(/import "~\/site-header\.css";/);
  });
});

describe("J62: Foxhound's own Checkout flow, never Recova's billing portal link", () => {
  it("neither the route nor the service calls a Stripe billing portal or links to billing.stripe.com", () => {
    for (const f of ["app/routes/utility/card-update.tsx", "app/lib/card-update/service.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/billingPortal\s*\./);
      expect(src, f).not.toMatch(/billing\.stripe\.com/);
    }
  });

  it("the guard can see a billing portal call, so its silence means something", () => {
    expect("stripe.billingPortal.sessions.create({})").toMatch(/billingPortal\s*\./);
    expect('"https://billing.stripe.com"').toMatch(/billing\.stripe\.com/);
  });
});
