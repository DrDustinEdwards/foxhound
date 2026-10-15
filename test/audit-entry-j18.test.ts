import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { STRIPE_AUDIT_SCOPE } from "~/lib/constants";
import routes from "~/routes";
import AuditPage from "~/routes/audit";

// J18 (job_6b6b876976d3), row M22: /audit, the visual walk. The spec is
// Recova's app/audit/page.tsx (blob 054edf70, 3893 bytes) and
// app/audit/layout.tsx (blob 0544e53b, 823 bytes), read whole. Recova is the
// spec for the content, order and width (the 680px centred column, the pill,
// the h1, the lead, the covers card with its "See my numbers" button and its
// note, the two figure cards, the demo line); the look is Capsomer's (RULES.md
// 1.1, Q12), teal (Q11), on the five text sizes (RULES.md 5.2). Foxhound's
// estimator stays where ruling 86 put it.
//
// These read the RENDERED page in each of its three states (estimator ready,
// estimator unavailable, an estimate shown), so a class on a helper that never
// reaches the page cannot pass.

const ESTIMATE = {
  ok: true as const,
  currency: "usd",
  mrrCents: 5_000_000,
  result: { estimatedLeakageCents: 120_000, low: 80_000, high: 160_000 },
};

function render(opts: { turnstile: boolean; actionData?: unknown }): string {
  const loaderData = {
    siteUrl: "https://example.com",
    turnstileAvailable: opts.turnstile,
    turnstileSiteKey: opts.turnstile ? "sample-site-key" : "",
  };
  const props = { loaderData, actionData: opts.actionData, params: {}, matches: [] };
  const router = createMemoryRouter(
    // The route component is rendered with the props React Router would hand it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [{ path: "*", element: createElement(AuditPage as any, props) }],
    { initialEntries: ["/audit"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** The page body: Recova's 680px column and everything in it. */
function column(html: string): string {
  const at = html.indexOf("max-w-[680px]");
  expect(at, "the 680px column is on the page").toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<div", at));
}

/** The opening tag of every element whose class list holds `cls`. */
function tagsWithClass(html: string, cls: string): string[] {
  return [...html.matchAll(/<[a-z0-9]+ [^>]*class="([^"]*)"[^>]*>/g)]
    .filter((m) => m[1].split(/\s+/).includes(cls))
    .map((m) => m[0]);
}

function classOf(tag: string): string[] {
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
}

/** Every link whose text includes `text`, opening tag through close. */
function linksWith(html: string, text: string): string[] {
  return [...html.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]).filter((a) => a.includes(text));
}

interface RouteEntry {
  path?: string;
  index?: boolean;
  children?: RouteEntry[];
}

function routePaths(entries: RouteEntry[], parent = "", out = new Set<string>()): Set<string> {
  for (const e of entries) {
    let path = parent;
    if (e.path) {
      path = `${parent}/${e.path.replace(/^\/+|\/+$/g, "")}`;
      out.add(path);
    } else if (e.index) {
      out.add(parent === "" ? "/" : parent);
    }
    if (e.children) routePaths(e.children, path, out);
  }
  return out;
}

const FIVE_SIZES = new Set(["text-display", "text-title", "text-body", "text-label", "text-micro"]);
// Tailwind's text-* utilities that are colours or alignment, not sizes.
const NOT_A_SIZE =
  /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|accent-hover|brand-text|green|blue|center|left|right)$/;

const STATES = {
  ready: render({ turnstile: true }),
  unavailable: render({ turnstile: false }),
  estimate: render({ turnstile: true, actionData: ESTIMATE }),
};

describe("/audit (J18, row M22)", () => {
  const html = STATES.ready;
  const body = column(html);

  it("sits in Capsomer's teal family with Foxhound's neutrals, in Recova's 680px centred column", () => {
    const open = body.slice(0, body.indexOf(">") + 1);
    expect(open).toContain("fh-cap");
    expect(open).toContain('data-family="teal"');
    for (const cls of ["mx-auto", "max-w-[680px]", "px-4", "py-10", "text-center", "md:px-8", "md:py-20"]) {
      expect(classOf(open), `${cls} on the column`).toContain(cls);
    }
  });

  it("keeps Recova's order: pill, h1, lead, ... covers card, the two figures, the demo line", () => {
    const order = [
      "FREE LOST REVENUE AUDIT",
      "<h1",
      "What the audit covers",
      "See my numbers",
      "Read-only Stripe access. 30 seconds. No account required.",
      "$0",
      "Want to see the app before connecting?",
      "View live demo",
    ].map((s) => body.indexOf(s));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("draws the pill as Capsomer's badge, with no Foxhound class on it", () => {
    const pills = tagsWithClass(body, "cap-pill");
    expect(pills).toHaveLength(1);
    expect(classOf(pills[0])).toEqual(["cap-pill"]);
    expect(body).toMatch(/<span class="cap-pill"[^>]*>FREE LOST REVENUE AUDIT<\/span>/);
  });

  it("sets the h1 on the display size, with Recova's weight, leading and tracking", () => {
    const h1 = /<h1 [^>]*>/.exec(body)?.[0] ?? "";
    expect(classOf(h1)).toEqual(expect.arrayContaining(["text-display", "font-semibold", "leading-[1.15]", "tracking-[-1px]"]));
    expect((body.match(/<h1[\s>]/g) ?? []).length).toBe(1);
  });

  it("carries Recova's h1 word for word, the same in every state of the estimator", () => {
    for (const state of Object.values(STATES)) {
      expect(column(state)).toMatch(/<h1 [^>]*>See everything leaking from your Stripe account<\/h1>/);
    }
  });

  it("makes each section label a real h2 under the h1 (RULES.md 1.5: a heading is never demoted)", () => {
    expect(body).toMatch(/<h2 [^>]*>What the audit covers<\/h2>/);
    expect(body).toMatch(/<h2 [^>]*>Free leakage estimator<\/h2>/);
  });

  it("builds every card from Capsomer's panel, body only, with no Foxhound class on the panel", () => {
    const panels = tagsWithClass(body, "cap-panel");
    // The estimator, the note, the covers card, the two figures and the closing offer.
    expect(panels).toHaveLength(6);
    for (const tag of panels) expect(classOf(tag)).toEqual(["cap-panel"]);
    expect(tagsWithClass(body, "cap-panel-body")).toHaveLength(6);
    for (const tag of tagsWithClass(body, "cap-panel-body")) expect(classOf(tag)).toEqual(["cap-panel-body"]);
  });

  it("draws \"See my numbers\" as Capsomer's large primary button, full width, to /audit/connect", () => {
    const [cta] = linksWith(body, "See my numbers");
    expect(cta).toBeDefined();
    const tag = cta.slice(0, cta.indexOf(">") + 1);
    expect(classOf(tag)).toEqual(["cap-btn"]);
    expect(tag).toContain('data-variant="primary"');
    expect(tag).toContain('data-size="lg"');
    expect(tag).toContain('href="/audit/connect"');
    const before = body.slice(0, body.indexOf(cta));
    expect(before.slice(before.lastIndexOf("<div")), "a one-column grid stretches it").toMatch(/^<div class="grid[" ]/);
  });

  it("draws every other call to action as Capsomer's primary button, with no Foxhound class", () => {
    const run = linksWith(body, "Run the free audit");
    expect(run).toHaveLength(1);
    for (const a of [...run, ...linksWith(STATES.estimate, "Run the free audit on your real numbers")]) {
      const tag = a.slice(0, a.indexOf(">") + 1);
      expect(classOf(tag)).toEqual(["cap-btn"]);
      expect(tag).toContain('data-variant="primary"');
      expect(tag).toContain('href="/audit/connect"');
    }
  });

  // The full pin of the published sentence against the request, in both
  // directions, is test/audit-oauth-phase-f.test.ts ("THE PUBLISHED SENTENCE IS
  // PINNED AGAINST THE REQUEST"); this checks only that the note renders here.
  it("keeps the read-only note true: the audit's Stripe request is read_only", () => {
    expect(body).toContain("Read-only Stripe access. 30 seconds. No account required.");
    expect(STRIPE_AUDIT_SCOPE).toBe("read_only");
  });

  it("builds the estimator form from Capsomer's field, select and button", () => {
    const fields = tagsWithClass(body, "cap-field");
    expect(fields).toHaveLength(3);
    for (const name of ["mrr", "customerCount"]) {
      const input = new RegExp(`<input [^>]*name="${name}"[^>]*>`).exec(body)?.[0] ?? "";
      expect(classOf(input), `${name} is a Capsomer input`).toEqual(["cap-input"]);
      const id = /id="([^"]+)"/.exec(input)?.[1] ?? "";
      expect(id, `${name} has an id`).not.toBe("");
      expect(body, `${name} has a label pointing at it`).toMatch(new RegExp(`<label class="cap-field-label" for="${id}"`));
    }
    const select = /<select [^>]*name="currency"[^>]*>/.exec(body)?.[0] ?? "";
    expect(classOf(select)).toEqual(["cap-select"]);
    expect(body).toMatch(/<div class="cap-select-wrap"><select /);
    const submit = /<button [^>]*type="submit"[^>]*>/.exec(body)?.[0] ?? "";
    expect(classOf(submit)).toEqual(["cap-btn"]);
    expect(submit).toContain('data-variant="primary"');
  });

  it("says the estimator is unavailable in Capsomer's info banner, a standing notice that is not an alert", () => {
    const off = column(STATES.unavailable);
    const banners = tagsWithClass(off, "cap-banner");
    expect(banners).toHaveLength(1);
    expect(banners[0]).toContain('data-tone="info"');
    expect(banners[0]).toContain('role="status"');
    expect(tagsWithClass(off, "cap-alert")).toHaveLength(0);
    expect(off).not.toContain('role="alert"');
    expect(off).toContain("The estimator is temporarily unavailable");
    expect(off).not.toContain("<form");
  });

  it("gives the demo link at least a 24px target in the accent's link colours", () => {
    const [demo] = linksWith(body, "View live demo");
    const tag = demo.slice(0, demo.indexOf(">") + 1);
    expect(tag).toContain('href="/demos/recovery"');
    expect(classOf(tag)).toEqual(expect.arrayContaining(["min-h-6", "text-accent-text", "hover:text-accent-hover"]));
  });

  it("draws no card or button from hand-rolled class strings", () => {
    for (const state of Object.values(STATES)) {
      const b = column(state);
      expect(b).not.toMatch(/rounded-\[(10|12)px\]/);
      expect(b).not.toMatch(/\brounded-2xl\b/);
      expect(b).not.toMatch(/\bbg-brand\b/);
      expect(b).not.toMatch(/\bbg-surface2?\b/);
      expect(b).not.toMatch(/\bborder-border\b/);
    }
  });

  it("carries no amber anywhere on the page", () => {
    for (const state of Object.values(STATES)) expect(state).not.toMatch(/amber/i);
  });

  it("uses only the five standard text sizes in every state, never an arbitrary text-[ value", () => {
    for (const state of Object.values(STATES)) {
      const b = column(state);
      expect(b).not.toMatch(/text-\[/);
      const sizes: string[] = [];
      for (const m of b.matchAll(/class="([^"]*)"/g)) {
        for (const c of m[1].split(/\s+/)) {
          const base = c.replace(/^[a-z0-9-]+:/g, "");
          if (base.startsWith("text-") && !NOT_A_SIZE.test(base)) sizes.push(base);
        }
      }
      expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(0);
      for (const s of sizes) expect(FIVE_SIZES.has(s), `${s} is one of the five`).toBe(true);
    }
  });

  it("points every internal link at a route that exists", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/audit/connect"), "the matcher finds a known route").toBe(true);
    for (const state of Object.values(STATES)) {
      const hrefs = [...column(state).matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const h of hrefs) expect(paths.has(h), `${h} is a route`).toBe(true);
    }
  });
});
