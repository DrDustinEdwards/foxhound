import { readFileSync } from "node:fs";

import postcss, { type Rule } from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { PRODUCT_ORDER, PRODUCTS } from "~/lib/marketing/products";
import routes from "~/routes";
import PricingPage from "~/routes/pricing";

// J54 (job_72985caa71f1), row M4: /pricing's layout, links, structured data and
// look. The spec is Recova's app/(marketing)/pricing/page.tsx (blob 8e91e160),
// read whole. Layout is Recova's; the look is Capsomer's (RULES.md 1.1): each
// card and FAQ item is Capsomer's panel in the teal family, the closing link is
// Capsomer's primary button, and text is on the five sizes (RULES.md 5.2). The
// copy is pinned in pricing-j54-copy.test.ts.
//
// These read the RENDERED page, so a class on a helper that never reaches a
// reader cannot pass.

const SITE = "https://example.com";

function render(): string {
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(PricingPage as never, { loaderData: { siteUrl: SITE } }) }],
    { initialEntries: ["/pricing"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

/** Everything below the shared page header (row M29, not this job's). */
function body(html: string): string {
  const at = html.indexOf("<section");
  expect(at, "the page has sections below its header").toBeGreaterThan(-1);
  return html.slice(at);
}

/** One card per product, from its id to the next card or the end of the grid. */
function cards(html: string): Map<string, string> {
  const at = html.indexOf("max-w-[1200px]");
  expect(at, "the 1200px card container is on the page").toBeGreaterThan(-1);
  const grid = html.slice(at, html.indexOf("</section>", at));
  const out = new Map<string, string>();
  const starts = PRODUCT_ORDER.map((k) => grid.indexOf(`id="${k}"`));
  PRODUCT_ORDER.forEach((k, i) => {
    expect(starts[i], `the ${k} card is on the page`).toBeGreaterThan(-1);
    const from = grid.lastIndexOf("<", starts[i]);
    out.set(k, grid.slice(from, i + 1 < starts.length ? grid.lastIndexOf("<", starts[i + 1]) : undefined));
  });
  return out;
}

/** The "Learn more" anchor in a card. */
function learnMore(card: string): string {
  const m = /<a [^>]*>Learn more[\s\S]*?<\/a>/.exec(card);
  expect(m, "the card has its Learn more link").not.toBeNull();
  return m?.[0] ?? "";
}

/** A rendered element's text with its markup removed, as an accessible name is read. */
const text = (fragment: string) => fragment.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "");

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
  /^text-(text|text-secondary|text-tertiary|text-subtle|accent-text|accent-hover|brand-text|center|left|right)$/;

describe("/pricing layout and links (J54, row M4)", () => {
  const html = render();

  it("renders Recova's four cards in Recova's order, each keeping its id and 60px scroll margin", () => {
    const order = PRODUCT_ORDER.map((k) => html.indexOf(`id="${k}"`));
    expect(order.every((n) => n > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const [k, card] of cards(html)) {
      const tag = card.slice(0, card.indexOf(">") + 1);
      expect(tag, k).toContain("scroll-mt-[60px]");
    }
  });

  it("points every Learn more at PRODUCTS[key].href, and every one is a route in app/routes.ts", () => {
    const paths = routePaths(routes as RouteEntry[]);
    expect(paths.has("/pricing"), "the matcher finds a known route").toBe(true);
    for (const [k, card] of cards(html)) {
      const href = /href="([^"]+)"/.exec(learnMore(card))?.[1];
      expect(href, k).toBe(PRODUCTS[k as keyof typeof PRODUCTS].href);
      expect(paths.has(href ?? ""), `${href} is a route`).toBe(true);
    }
  });

  it("reads the Learn more destination from products.ts, never builds it by hand", () => {
    // J09 reverts the spoke URLs to Recova's /product/* in products.ts alone, so
    // a hand-built path here would be left behind on the old route.
    const src = readFileSync(new URL("../app/routes/pricing.tsx", import.meta.url), "utf8");
    expect(src.length).toBeGreaterThan(1000);
    expect(src).not.toMatch(/[`"']\/products?\/\$\{/);
    expect(src).toMatch(/PRODUCTS\[[^\]]+\]\.href/);
  });

  it("gives each Learn more a distinct accessible name that starts with its visible text", () => {
    const names = [...cards(html).values()].map((c) => text(learnMore(c)).replace(/\s+/g, " ").trim());
    expect(new Set(names).size, names.join(" | ")).toBe(4);
    for (const [k, card] of cards(html)) {
      const link = learnMore(card);
      const name = text(link).replace(/\s+/g, " ").trim();
      // Label in name: the visible words lead the name; the rest is hidden from sight only.
      expect(name.startsWith("Learn more"), name).toBe(true);
      expect(name, k).toContain(PRODUCTS[k as keyof typeof PRODUCTS].name);
      expect(link).toMatch(/<span class="sr-only">[^<]+<\/span>/);
      expect(link).toMatch(/<svg[^>]*aria-hidden="true"/);
    }
  });

  it("gives each Learn more a 24px target and the CTA Capsomer's button height", () => {
    for (const card of cards(html).values()) {
      const tag = learnMore(card).slice(0, learnMore(card).indexOf(">"));
      expect(tag).toMatch(/\b(leading-6|min-h-6)\b/);
    }
    expect(body(html)).toMatch(/<a [^>]*href="\/audit"[^>]*>/);
  });

  it("keeps Recova's widths: 1200px cards on a 1/2/4 grid with gap-4, a 760px FAQ and CTA, a 560px CTA line", () => {
    expect(html).toContain("max-w-[1200px]");
    expect(html).toMatch(/class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"/);
    expect((html.match(/max-w-\[760px\]/g) ?? []).length).toBe(2);
    expect(html).toContain("max-w-[560px]");
  });

  it("leaves Recova's annual note off the page (PRICING.md rev 3 item 3, ruling 53)", () => {
    expect(html).not.toContain("Annual plans");
    expect(html).not.toContain("2 months free");
    expect(html).not.toContain("per-account rate");
  });
});

describe("/pricing headings (J54)", () => {
  const html = render();
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));

  it("has one h1 and never skips a level", () => {
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i], `heading ${i}`).toBeLessThanOrEqual(levels[i - 1] + 1);
  });

  it("heads the FAQ and the closing block with h2, each question with h3, each card with a heading", () => {
    expect(html).toMatch(/<h2[^>]*>Questions<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>See what your Stripe account is leaking<\/h2>/);
    expect((html.match(/<h3[^>]*>[^<]+\?<\/h3>/g) ?? []).length).toBe(4);
    for (const k of PRODUCT_ORDER) {
      expect(html).toMatch(new RegExp(`<h[23][^>]*>${PRODUCTS[k].name}</h[23]>`));
    }
  });
});

describe("/pricing structured data (J54)", () => {
  const html = render();
  const raw = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const data = JSON.parse(raw || "null") as unknown;

  it("emits an array of FAQPage and a speakable WebPage, as Recova does", () => {
    expect(Array.isArray(data), "the JSON-LD is an array").toBe(true);
    const arr = data as { "@type": string }[];
    expect(arr.map((d) => d["@type"])).toEqual(["FAQPage", "WebPage"]);
  });

  it("the FAQPage carries every question the page renders", () => {
    const faq = (Array.isArray(data) ? data : [data])[0] as { mainEntity: { name: string }[] };
    const shown = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1].replace(/&quot;/g, '"'));
    expect(shown.length).toBeGreaterThan(0);
    expect(faq.mainEntity.map((q) => q.name)).toEqual(shown);
  });

  it("names the WebPage for Foxhound at /pricing, and every speakable selector matches a section on the page", () => {
    const page = (Array.isArray(data) ? data[1] : undefined) as
      | { name: string; url: string; speakable: { "@type": string; cssSelector: string[] } }
      | undefined;
    expect(page?.name).toBe("Pricing | Foxhound");
    expect(page?.url).toBe(`${SITE}/pricing`);
    expect(page?.speakable["@type"]).toBe("SpeakableSpecification");
    const selectors = page?.speakable.cssSelector ?? [];
    expect(selectors).toEqual([".speakable-pricing-cards", ".speakable-pricing-faq"]);
    const sectionClasses = [...html.matchAll(/<section class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
    for (const s of selectors) expect(sectionClasses, s).toContain(s.slice(1));
    // The cards selector holds the cards and the FAQ selector holds the questions.
    const cardsAt = html.indexOf("speakable-pricing-cards");
    const faqAt = html.indexOf("speakable-pricing-faq");
    expect(html.indexOf('id="audit"')).toBeGreaterThan(cardsAt);
    expect(html.indexOf(">Questions<")).toBeGreaterThan(faqAt);
  });
});

describe("/pricing look: Capsomer, teal, five sizes (J54)", () => {
  const html = render();

  it("sits in Capsomer's teal family with Foxhound's neutrals, and its focus ring reads the family's ring", () => {
    const at = html.indexOf("fh-cap");
    expect(at).toBeGreaterThan(-1);
    const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
    expect(tag).toContain('data-family="teal"');
    expect(tag).toContain("[--border-focus:var(--ring)]");
    expect(at, "the wrapper holds the cards").toBeLessThan(html.indexOf("max-w-[1200px]"));
  });

  it("builds every card from Capsomer's panel, with no Foxhound class on the panel", () => {
    for (const [k, card] of cards(html)) {
      const panels = [...card.matchAll(/class="(cap-panel[^"]*)"/g)].map((m) => m[1]);
      expect(panels, k).toEqual(["cap-panel", "cap-panel-body"]);
    }
  });

  it("builds every FAQ item from Capsomer's panel", () => {
    const faq = html.slice(html.indexOf(">Questions<"));
    const items = [...faq.matchAll(/<li class="([^"]*)"/g)].map((m) => m[1]);
    expect(items).toHaveLength(4);
    for (const c of items) expect(c).toBe("cap-panel");
  });

  it("makes the closing link Capsomer's primary button", () => {
    const cta = /<a [^>]*href="\/audit"[^>]*>/.exec(html)?.[0] ?? "";
    expect(cta).toContain('class="cap-btn"');
    expect(cta).toContain('data-variant="primary"');
    expect(cta).toContain('data-size="lg"');
  });

  it("carries no amber anywhere on the page", () => {
    expect(html.length).toBeGreaterThan(5000);
    expect(html).not.toMatch(/amber/i);
  });

  it("draws each card's price, check icons and Learn more in Capsomer's accent text", () => {
    for (const [k, card] of cards(html)) {
      const checks = (card.match(/<svg[^>]*lucide-check[^>]*>/g) ?? []).length;
      expect(checks, `${k} has check icons`).toBeGreaterThan(0);
      for (const svg of card.match(/<svg[^>]*lucide-check[^>]*>/g) ?? []) expect(svg).toContain("text-accent-text");
      expect(learnMore(card).slice(0, learnMore(card).indexOf(">"))).toContain("text-accent-text");
      // The price figure: the one classed span with text in the card.
      expect(card, `${k} price`).toMatch(/<span class="[^"]*font-mono[^"]*text-accent-text[^"]*">[^<]+<\/span>/);
      expect(card).not.toContain("text-brand-text");
    }
  });

  it("uses only the five standard text sizes below the shared header, never an arbitrary text-[ value", () => {
    const b = body(html);
    expect(b).not.toMatch(/text-\[/);
    const sizes: string[] = [];
    for (const m of b.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) {
        const base = c.replace(/^[a-z0-9-]+:/g, "");
        if (base.startsWith("text-") && !NOT_A_SIZE.test(base)) sizes.push(base);
      }
    }
    expect(sizes.length, "the page carries size classes to check").toBeGreaterThan(5);
    for (const s of sizes) expect(FIVE_SIZES.has(s), `${s} is one of the five`).toBe(true);
  });
});

describe("/pricing button focus (J54)", () => {
  // Foxhound's own unlayered *:focus-visible rule (app/app.css) draws a 2px
  // outline and squares every focused element's corners to 2px, which beats
  // Capsomer's layered ring on the button. A later unlayered rule hands the
  // three properties back to the layer below, as app/error-page.css does for
  // the error page's buttons; it adds nothing to the component.
  const root = postcss.parse(readFileSync(new URL("../app/app.css", import.meta.url), "utf8"));
  const rules: Rule[] = [];
  root.walkRules((r) => {
    let parent = r.parent;
    while (parent && parent.type !== "root") {
      if (parent.type === "atrule" && (parent as { name?: string }).name === "layer") return;
      parent = parent.parent;
    }
    rules.push(r);
  });

  it("hands a Capsomer button inside .fh-cap back its own ring and corners", () => {
    expect(rules.length, "the parser found unlayered rules").toBeGreaterThan(10);
    const rule = rules.find((r) => r.selectors.includes(".fh-cap .cap-btn:focus-visible"));
    expect(rule, "a rule for .fh-cap .cap-btn:focus-visible").toBeDefined();
    const decls: Record<string, string> = {};
    rule?.walkDecls((d) => {
      decls[d.prop] = d.value;
    });
    expect(decls).toMatchObject({
      outline: "revert-layer",
      "outline-offset": "revert-layer",
      "border-radius": "revert-layer",
    });
  });
});
