import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { ErrorView } from "~/components/error-view";
import { WITHDRAWN_BLOG_MESSAGE } from "~/lib/blog/withdrawn";

// J21: the 404 and error page on Capsomer's button, teal, and Foxhound's five
// text sizes (RULES 5.2). Asserted on the rendered markup of every state, since
// what changed is entirely what a reader sees.

function routeError(status: number, statusText: string, data: unknown) {
  return { status, statusText, internal: false, data };
}

function render(error: unknown) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ErrorView, { error })));
}

const STATES = {
  "404": () => render(routeError(404, "Not Found", "ignored")),
  "410 withdrawn": () => render(routeError(410, "Gone", WITHDRAWN_BLOG_MESSAGE)),
  "500 thrown Error": () => render(new Error("boom")),
  "503 route error": () => render(routeError(503, "Service Unavailable", "Down for a moment")),
};

/** The CTA row: every <a> and <button> after the h1. The bar's home link is
 *  before it and is not a button. */
function ctas(html: string): string[] {
  const after = html.slice(html.indexOf("</h1>"));
  return [...after.matchAll(/<(a|button)\b[^>]*>/g)].map((m) => m[0]);
}

describe.each(Object.entries(STATES))("the %s page", (_name, page) => {
  it("carries no amber anywhere (J81 has not landed; this page is teal now)", () => {
    expect(page()).not.toMatch(/amber/);
  });

  it("uses no arbitrary text size, only the five standard ones", () => {
    expect(page()).not.toMatch(/\btext-\[/);
    expect(page()).not.toMatch(/\btext-(xs|sm|base|lg|xl|[2-9]xl)\b/);
  });

  it("draws every CTA as Capsomer's button at the large size", () => {
    const row = ctas(page());
    expect(row.length).toBeGreaterThan(0);
    for (const tag of row) {
      expect(tag).toMatch(/class="cap-btn"/);
      expect(tag).toContain('data-size="lg"');
    }
  });

  it("makes exactly one CTA the primary", () => {
    expect(ctas(page()).filter((t) => t.includes('data-variant="primary"'))).toHaveLength(1);
  });

  it("puts the page on the teal family in Foxhound's neutrals", () => {
    expect(page()).toMatch(/<main[^>]*class="[^"]*\bfh-cap\b[^"]*"[^>]*data-family="teal"/);
  });

  it("keeps one main landmark and the bar's home link", () => {
    const html = page();
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toMatch(/<a href="\/" aria-label="Foxhound home"/);
  });
});

describe("Try again stays a real button", () => {
  it("is a type=button primary on a fault", () => {
    const html = STATES["500 thrown Error"]();
    expect(html).toMatch(/<button type="button" class="cap-btn" data-size="lg" data-variant="primary">Try again<\/button>/);
  });
});
