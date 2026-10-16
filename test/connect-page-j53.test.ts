import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { STRIPE_CONNECT_SCOPE } from "~/lib/constants";
import { buildConnectAuthorizeUrl } from "~/lib/stripe/connect";

const { default: Connect } = await import("~/routes/auth/connect");

// J53 (job_9bdc85a1ab9d), row A6: /connect, the Stripe consent page.
//
// Recova is the spec for the page's content, layout and features: its
// app/connect/page.tsx (blob a79ee373, 4984 bytes), read whole. One 480px card
// centred on the page, holding the h1 "Connect your Stripe account", the line
// under it, the error notice, the access-disclosure panel ruling 20(d) owes,
// the full-width "Connect Stripe" button, "Not ready? See a demo first" and
// "Manage account". Its parts are Capsomer's (Q12), teal (Q11), on the five
// text sizes (RULES.md 5.2).
//
// The Stripe scope is never narrowed to fit the copy: the copy is fixed to fit
// the scope (RULES.md 2.2). Recova's own lines are kept word for word where
// they are true of Foxhound; the three that are not are named in the tests
// below with the reason.
//
// These read the RENDERED page, so a class on a helper that never reaches a
// reader cannot pass for one that does.

type Props = Parameters<typeof Connect>[0];
type LoaderData = Props["loaderData"];

function render(loaderData: LoaderData, actionData?: { error: string }): string {
  const props = { loaderData, actionData, params: {}, matches: [] } as unknown as Props;
  const router = createMemoryRouter([{ path: "*", element: createElement(Connect, props) }], {
    initialEntries: ["/connect"],
  });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** The opening tag of the first element carrying `cls`, so attributes can be read off it. */
function tagWith(html: string, cls: RegExp): string {
  const m = html.match(new RegExp(`<[a-z]+[^>]*class="[^"]*${cls.source}[^"]*"[^>]*>`));
  expect(m, `an element with ${cls.source} is on the page`).not.toBeNull();
  return m![0];
}

/** Visible text, tags stripped and whitespace collapsed, for order checks. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
}

/** Assert each needle appears, in this order. */
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

const CONNECT: LoaderData = {
  hasAccount: true,
  accountName: "Acme Supply Co.",
  userName: "Dana",
  hasConnection: false,
  stripeEnabled: true,
  error: null,
};
const NAME_STEP: LoaderData = { ...CONNECT, hasAccount: false, accountName: null };
const CONNECTED: LoaderData = { ...CONNECT, hasConnection: true };

describe("J53: the page is Recova's one card, built from Capsomer's parts", () => {
  it("one 480px column, no two-column sign-in frame and no merchant sales panel", () => {
    const html = render(CONNECT);
    expect(html).toContain("max-w-[480px]");
    // AuthShell's brand panel and its pitch are not on Recova's /connect.
    expect(html).not.toContain("Outcome-based recovery for Stripe merchants.");
    expect(html).not.toContain("max-w-5xl");
  });

  it("no second main landmark: the marketing layout already renders main", () => {
    for (const state of [CONNECT, NAME_STEP, CONNECTED]) {
      expect(render(state)).not.toMatch(/<main[\s>]/);
    }
  });

  it("the card is a Capsomer panel inside the teal family wrapper", () => {
    const html = render(CONNECT);
    const wrap = tagWith(html, /fh-cap/);
    expect(wrap).toContain('data-family="teal"');
    expect(html).toMatch(/<section class="cap-panel"><div class="cap-panel-body">/);
  });

  it("Recova's heading and the line under it, with Foxhound's name", () => {
    const html = render(CONNECT);
    expect(html).toMatch(/<h1[^>]*>Connect your Stripe account<\/h1>/);
    expect(text(html)).toContain(
      "Foxhound needs read/write access to retry failed invoices on your behalf. You can disconnect at any time.",
    );
  });

  it("Recova's order: heading, line, panel, button, demo link, manage account", () => {
    inOrder(text(render(CONNECT)), [
      "Connect your Stripe account",
      "Foxhound needs read/write access",
      "What Foxhound can do",
      "What Foxhound can never do",
      "Connect Stripe",
      "Not ready? See a demo first",
      "Manage account",
    ]);
  });
});

describe("J53: the access-disclosure panel (ruling 20(d)), true of Foxhound's scope", () => {
  it("the scope it describes is still read_write: the copy fits the scope, never the reverse", () => {
    expect(STRIPE_CONNECT_SCOPE).toBe("read_write");
    const url = buildConnectAuthorizeUrl(
      { STRIPE_CLIENT_ID: "ca_test", BETTER_AUTH_URL: "https://example.com" } as unknown as Env,
      "s",
    );
    expect(new URL(url).searchParams.get("scope")).toBe("read_write");
  });

  it("what Foxhound can do: every read and write the grant is used for", () => {
    const t = text(render(CONNECT));
    inOrder(t, [
      "What Foxhound can do",
      // Main's wider read line stays until Dustin rules (RULES.md 2.2, PR #65
      // open question 1): Recova's "View failed invoices and payment history"
      // says less than Foxhound reads (all customers, subscriptions, invoices,
      // charges and disputes).
      "Read your invoices, subscriptions, disputes, and customer records",
      "Retry failed invoice payments",
      "Set a customer default payment method after that customer updates their card",
      // Win-back: card-update/service.ts createResubscribeSession opens a
      // subscription-mode Checkout on the connected account.
      "Open a Stripe checkout when a former customer chooses to resubscribe",
      "Submit dispute evidence, only after someone on your team approves it",
      // J06: Accept closes the dispute at Stripe (disputes/accept.server.ts).
      "Close a dispute at Stripe, only when you choose to accept it",
      "What Foxhound can never do",
    ]);
    expect(t).not.toContain("View failed invoices and payment history");
  });

  it("what Foxhound can never do: Recova's true lines word for word, its false one corrected", () => {
    const t = text(render(CONNECT));
    inOrder(t, [
      "What Foxhound can never do",
      "Charge a customer except by retrying a failed invoice or through a checkout they complete",
      "Access your payouts or bank account",
      "Store raw card data",
      "Connect Stripe",
    ]);
  });

  it("Recova's two untrue lines are not shown", () => {
    const t = text(render(CONNECT));
    // Foxhound registers no webhook on a connected account: Connect events
    // reach one platform endpoint.
    expect(t).not.toContain("Register a webhook");
    // Retrying an invoice moves money, so "never move money" is false.
    expect(t).not.toContain("Create new charges or move money");
  });

  it("never claims Foxhound charges only on invoices the merchant issued, while win-back checkout exists", () => {
    // The win-back resubscribe checkout makes a new subscription, invoice and
    // charge on the merchant's account when the customer completes it, so
    // "outside an invoice you already issued" is false while it exists.
    const service = readFileSync("app/lib/card-update/service.ts", "utf8");
    expect(service).toMatch(/export async function createResubscribeSession/);
    expect(service).toMatch(/mode: "subscription"/);
    const t = text(render(CONNECT));
    expect(t).not.toMatch(/outside an invoice you already issued/i);
  });

  it("nothing Recova's panel lacks is added beyond the truthfulness fixes", () => {
    const t = text(render(CONNECT));
    expect(t).not.toContain("Change your prices, products, or subscription plans");
    expect(t).not.toContain("which stops every active sequence");
    expect(t).not.toContain("Here is exactly what that covers");
  });

  it("each list is a list, named by its heading", () => {
    const html = render(CONNECT);
    const lists = [...html.matchAll(/<ul[^>]*aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(lists).toHaveLength(2);
    for (const id of lists) expect(html).toMatch(new RegExp(`id="${id}"[^>]*>What Foxhound can`));
  });
});

describe("J53: the one action is Capsomer's primary Button, full width as Recova's", () => {
  it("Connect Stripe submits a POST through a cap-btn primary", () => {
    const html = render(CONNECT);
    const btn = tagWith(html, /cap-btn/);
    expect(btn).toMatch(/^<button/);
    expect(btn).toContain('type="submit"');
    expect(btn).toContain('data-variant="primary"');
    expect(html).toMatch(/<button[^>]*>Connect Stripe<\/button>/);
    // The form is a grid, so the button stretches to Recova's full width with
    // no class over Capsomer's button.
    const form = html.match(/<form[^>]*>/g)?.find((f) => f.includes('method="post"'));
    expect(form, "a POST form is on the page").toBeDefined();
    expect(form).toContain('class="grid"');
  });

  it("no hand-rolled button is left", () => {
    for (const state of [CONNECT, NAME_STEP]) expect(render(state)).not.toMatch(/bg-brand/);
  });

  it("Not ready? See a demo first goes to the read-only recovery demo", () => {
    const html = render(CONNECT);
    expect(html).toMatch(/Not ready\?\s*<a[^>]*href="\/demos\/recovery"[^>]*>See a demo first<\/a>/);
  });

  it("Manage account goes to settings, and Recova's page has no Skip for now", () => {
    const html = render(CONNECT);
    expect(html).toMatch(/<a[^>]*href="\/settings"[^>]*>Manage account<\/a>/);
    expect(text(html)).not.toContain("Skip for now");
  });

  it("the two links are underlined and at least 24px tall", () => {
    const html = render(CONNECT);
    for (const href of ["/demos/recovery", "/settings"]) {
      const m = html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`));
      expect(m, `a link to ${href} is on the page`).not.toBeNull();
      const a = m![0];
      expect(a).toContain("underline");
      expect(a).toContain("min-h-6");
    }
  });
});

describe("J53: Stripe's errors in Recova's words, in a Capsomer alert above the panel", () => {
  const RECOVA: [string, string][] = [
    ["denied", "You cancelled the Stripe connection. Try again when ready."],
    ["invalid_state", "Security check failed. Please try again."],
    ["no_code", "Stripe did not return an authorization code. Please try again."],
    ["token_exchange_failed", "Stripe could not complete the connection. Please try again."],
    ["something_else", "Something went wrong. Please try again."],
  ];

  for (const [code, message] of RECOVA) {
    it(`${code}: "${message}"`, () => {
      const html = render({ ...CONNECT, error: code });
      const alert = tagWith(html, /cap-alert/);
      expect(alert).toContain('role="alert"');
      expect(text(html)).toContain(message);
      inOrder(text(html), ["Foxhound needs read/write access", message, "What Foxhound can do"]);
    });
  }

  it("a Stripe account live on another Foxhound account says so, and names no account", () => {
    const t = text(render({ ...CONNECT, error: "stripe_account_already_connected" }));
    expect(t).toContain("This Stripe account is already connected to a Foxhound account.");
    expect(t).not.toContain("Please try again");
  });

  it("an action error is a Capsomer alert too", () => {
    const html = render(CONNECT, { error: "Stripe Connect is not configured in this environment yet." });
    expect(tagWith(html, /cap-alert/)).toContain('role="alert"');
  });
});

describe("J53: Foxhound's two other states sit in the same frame, words unchanged", () => {
  it("naming the account: Capsomer field and button, same words", () => {
    const html = render(NAME_STEP);
    expect(html).toMatch(/<h1[^>]*>Name your account<\/h1>/);
    expect(text(html)).toContain("One more step before you connect Stripe.");
    expect(html).toContain("cap-field");
    const input = tagWith(html, /cap-input/);
    expect(input).toContain('name="name"');
    expect(input).toContain("required");
    expect(text(html)).not.toContain("Required");
    expect(html).toMatch(/<button[^>]*data-variant="primary"[^>]*>Create account<\/button>/);
    expect(html).toContain("max-w-[480px]");
  });

  it("already connected: a Capsomer ok banner and the dashboard link, same words", () => {
    const html = render(CONNECTED);
    expect(html).toMatch(/<h1[^>]*>Stripe connected<\/h1>/);
    expect(tagWith(html, /cap-banner/)).toContain('data-tone="ok"');
    expect(text(html)).toContain("Your Stripe account is connected. Foxhound can now recover failed payments for you.");
    expect(html).toMatch(/<a[^>]*href="\/console"[^>]*>Go to dashboard<\/a>/);
  });
});

describe("J53: five text sizes and no amber", () => {
  it("every text size on the page is one of the five", () => {
    for (const state of [CONNECT, NAME_STEP, CONNECTED, { ...CONNECT, error: "denied" }]) {
      for (const c of sizeClasses(render(state))) expect(FIVE_SIZES.has(c), c).toBe(true);
    }
  });

  it("no amber anywhere on the rendered page", () => {
    for (const state of [CONNECT, NAME_STEP, CONNECTED]) expect(render(state)).not.toMatch(/amber/i);
  });

  it("the route loads the Capsomer CSS its parts read", () => {
    const src = readFileSync("app/routes/auth/connect.tsx", "utf8");
    for (const css of ["capsomer/panel.css", "capsomer/button.css", "capsomer/banner.css", "capsomer/field.css", "~/site-header.css"]) {
      expect(src).toContain(`import "${css}"`);
    }
  });
});
