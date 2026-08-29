import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { ErrorView } from "~/components/error-view";
import {
  WITHDRAWN_BLOG_HEADING,
  WITHDRAWN_BLOG_MESSAGE,
  WITHDRAWN_BLOG_REASON,
} from "~/lib/blog/withdrawn";

// 394 halt 4. The 410 served 391's withdrawal sentence in its body while the
// page around it said "Something went wrong" and offered "Try again", so the
// chrome contradicted the copy on the same response. Nothing went wrong; a
// person decided.
//
// These assertions are on the RENDERED page, not on a view model, because the
// defect was entirely in what a reader saw.

// isRouteErrorResponse duck-types on {status, statusText, internal, data}, the
// same stand-in test/error-boundary-message.test.ts uses.
function routeError(status: number, statusText: string, data: unknown) {
  return { status, statusText, internal: false, data };
}

function render(error: unknown) {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(ErrorView, { error })),
  );
}

const withdrawn = () => render(routeError(410, "Gone", WITHDRAWN_BLOG_MESSAGE));

describe("the served message keeps its shape", () => {
  it("composes byte-identically to the sentence the response body carries", () => {
    // The split exists to let the PAGE render a heading and a reason. It must
    // not move the served text, which the 391 test pins against the response.
    expect(WITHDRAWN_BLOG_MESSAGE).toBe(`${WITHDRAWN_BLOG_HEADING}. ${WITHDRAWN_BLOG_REASON}`);
    expect(WITHDRAWN_BLOG_MESSAGE).toBe(
      "This article has been withdrawn. It relied on third-party figures we could no longer verify against their sources, and we would rather publish nothing than publish numbers we cannot stand behind.",
    );
  });

  it("keeps the heading free of a trailing period, since it is also a heading", () => {
    expect(WITHDRAWN_BLOG_HEADING).not.toMatch(/\.$/);
  });
});

describe("the rendered 410 (394 halt 4)", () => {
  it("does not tell the reader something went wrong", () => {
    expect(withdrawn()).not.toContain("Something went wrong");
  });

  it("offers no retry of a URL that will never answer", () => {
    expect(withdrawn()).not.toContain("Try again");
  });

  it("offers no app link on an anonymous marketing surface", () => {
    expect(withdrawn()).not.toContain("Go to dashboard");
  });

  it("says the article was withdrawn, in the heading", () => {
    const html = withdrawn();
    const h1 = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
    expect(h1, "no h1 rendered").not.toBeNull();
    expect(h1![1]).toBe(WITHDRAWN_BLOG_HEADING);
  });

  it("gives the reason in one clause, without repeating the heading", () => {
    const html = withdrawn();
    expect(html).toContain(WITHDRAWN_BLOG_REASON);
    // The heading sentence appears once, in the h1, not again in the body.
    const occurrences = html.split(WITHDRAWN_BLOG_HEADING).length - 1;
    expect(occurrences).toBe(1);
  });

  it("offers exactly one link, to the blog", () => {
    const html = withdrawn();
    // Anchors, not substrings: a hydration payload or a class string can carry
    // a path that no reader can click (392).
    const hrefs = [...html.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
    // The kit's nav wordmark links home on every state; the CTA set is what is
    // under test, so drop the chrome link by taking what follows the h1.
    const afterHeading = html.slice(html.indexOf("</h1>"));
    const ctaHrefs = [...afterHeading.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toContain("/");
    expect(ctaHrefs).toEqual(["/blog"]);
  });

  it("renders no button at all, so there is nothing to press but the link", () => {
    expect(withdrawn()).not.toContain("<button");
  });

  it("carries the status numeral, in the expected-condition tone rather than the fault tone", () => {
    const html = withdrawn();
    const numeral = html.match(/<p[^>]*aria-label="410"[^>]*>410<\/p>/);
    expect(numeral, "the 410 numeral is not rendered").not.toBeNull();
    expect(numeral![0]).toContain("text-amber-text");
    expect(numeral![0]).not.toContain("text-red");
  });
});

describe("the other two states are untouched", () => {
  it("404 still reads as not found, with its three CTAs", () => {
    const html = render(routeError(404, "Not Found", "ignored"));
    expect(html).toContain("Page not found");
    expect(html).toContain("Go to dashboard");
    expect(html).toContain("View demo");
    expect(html).not.toContain(WITHDRAWN_BLOG_HEADING);
  });

  it("a real error still says so, and still offers the retry", () => {
    const html = render(routeError(500, "Internal Server Error", "Boom"));
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Try again");
    expect(html).toContain("Boom");
    // The fault tone is still the fault tone.
    expect(html).toMatch(/aria-label="500"/);
    expect(html.match(/<p[^>]*aria-label="500"[^>]*>500<\/p>/)![0]).toContain("text-red");
  });
});
