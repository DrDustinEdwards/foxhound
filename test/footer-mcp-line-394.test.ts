import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { Footer, MCP_LINE, type FooterVariant } from "~/components/footer";

// Footer's whole parameter is optional (it defaults to the marketing variant),
// so createElement resolves to the no-props overload and rejects `variant`.
// Narrowing the reference here keeps the component's public shape untouched.
const FooterWithVariant = Footer as (props: { variant: FooterVariant }) => ReactElement;

// 394 halt 2: the footer's MCP line was gated on "until MCP ships" (ruling 8,
// promise-ahead-of-product). MCP shipped and nobody moved the gate, so the line
// was owed back TOWARD legacy. These assertions are on the RENDERED footer
// rather than on the source, because the gate's failure mode was a line that
// existed in legacy and reached no reader here.
//
// Legacy's spec, components/SiteFooter.tsx: a plain <p> in the wordmark column,
// directly under the blurb, `mt-3 font-mono text-[0.6875rem]
// text-chrome-text-secondary`, and inside LinkColumns, which renders on the
// MARKETING variant only.

function render(variant: FooterVariant) {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(FooterWithVariant, { variant })),
  );
}

describe("footer MCP line (394 halt 2)", () => {
  it("carries legacy's string verbatim", () => {
    expect(MCP_LINE).toBe("Connect via MCP from any AI client");
  });

  it("renders the line on the marketing footer", () => {
    expect(render("marketing")).toContain(MCP_LINE);
  });

  it("renders it at legacy's treatment, on the element that holds it", () => {
    const html = render("marketing");
    // Take the tag that actually contains the text, so a matching class string
    // somewhere else on the page cannot satisfy this.
    const holder = html.match(/<p[^>]*>Connect via MCP from any AI client<\/p>/);
    expect(holder, "the line is not in a <p> of its own").not.toBeNull();
    const tag = holder![0];
    expect(tag).toContain("mt-3");
    expect(tag).toContain("font-mono");
    expect(tag).toContain("text-[0.6875rem]");
    expect(tag).toContain("text-chrome-text-secondary");
  });

  it("places it under the blurb, in the wordmark column", () => {
    const html = render("marketing");
    const blurb = html.indexOf("The recovery layer for Stripe merchants.");
    const line = html.indexOf(MCP_LINE);
    const firstColumnHeading = html.indexOf("Product");
    expect(blurb).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(blurb);
    // Still inside the wordmark column: it precedes the first link column.
    expect(line).toBeLessThan(firstColumnHeading);
  });

  it("does NOT render it on the app variant, because legacy puts it in LinkColumns", () => {
    expect(render("app")).not.toContain(MCP_LINE);
  });

  it("leaves no trace of the discharged gate in the shipped component", async () => {
    // The gate's own words must not survive as a comment claiming the line is
    // still held out. Cited by number rather than quoted, per ruling 387's
    // comment trap: quoting the replaced sentence puts it back in the file.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../app/components/footer.tsx", import.meta.url), "utf8"),
    );
    expect(src).not.toMatch(/stays out until\s+\/\/\s+MCP ships/);
    expect(src).not.toMatch(/which stays out until/);
  });
});
