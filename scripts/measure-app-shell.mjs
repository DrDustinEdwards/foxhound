// Ruling 146 (the <main> landmark) and 147 findings 1-3 (containers), measured.
//
// CONDITIONS, stated because 129/141 require the conditions AND the stores:
//   - LOCAL dev server. NOT production. Ruling 87 bars comparing a local build
//     to a deployed one, so no production claim is made here.
//   - A DEMO session, entered through /demos/dashboard, because the harness
//     holds no session cookie. Every claim below is demo-session evidence.
//   - Ruling 146 asks for both sides of the tab-bar breakpoint, so every page is
//     measured at 375 (bar renders) AND 1280 (bar does not).
//   - Each width is re-read from inside the page by withViewport, which throws
//     on mismatch, and the landing path is asserted so a /login bounce cannot
//     masquerade as "no main".

import { withViewport } from "./viewport-harness.mjs";

const BASE = process.env.BASE ?? "http://localhost:5199";
const ENTRY = `${BASE}/demos/dashboard`;

// row -> [path, expected max-width px at >=768, expected h-padding px at >=768]
const PAGES = [
  ["S2 /dashboard", "/dashboard", 1280, 32],
  ["S3 /billing", "/billing", 720, 32],
  ["S5 /recovery", "/recovery", 1280, 32],
  ["S6 /recovery/payments", "/recovery/payments", 1280, 32],
  ["S9 /recovery/sequences", "/recovery/sequences", 1280, 32],
];

const rows = [];
const rec = (w, page, claim, got, want, ok) =>
  rows.push({ w, page, claim, got: String(got), want: String(want), ok });

async function measure(width, label, path) {
  return withViewport(String(width), async (page) => {
    // Enter the demo session first, then navigate. goto on the entry route sets
    // the cookie; without it every app route 302s to /login and every landmark
    // reading would be about the wrong page (129's class).
    const resp = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const landed = await page.evaluate(() => location.pathname);
    if (landed !== path) {
      throw new Error(
        `LANDED ON ${landed}, NOT ${path}. The demo session did not hold, so the app shell was ` +
          `never rendered and any "no main" reading here would be about the wrong page.`,
      );
    }
    // THE PATH GUARD IS NOT ENOUGH. A 500 rendered by the root error boundary
    // keeps location.pathname correct, so an earlier run reported "zero <main>"
    // thirty times while the real cause was a JSX parse error and every page was
    // an error page.
    //
    // THE FIRST VERSION OF THIS GUARD MATCHED BODY TEXT AND WAS WORTHLESS. It
    // looked for "Something went wrong" and three siblings; the real 500 page's
    // entire visible text is the single word "Error" in 1769 bytes, so the guard
    // sat green through a deliberately broken page. That is ruling 114 in the
    // instrument written to fix an instrument: it probed the COPY, not the
    // MECHANISM. The status code is the mechanism and cannot be reworded.
    const status = resp ? resp.status() : 0;
    if (status !== 200) {
      throw new Error(
        `${path} RETURNED HTTP ${status}, not 200. The page did not render, so every landmark and ` +
          `container reading here would be about an error page. Asserting the condition applied (132/137/150).`,
      );
    }
    return page.evaluate(() => {
      const mains = document.querySelectorAll("main");
      const main = mains[0] ?? null;
      const container = main?.querySelector(":scope > * > div, :scope > div") ?? null;
      const footer = document.querySelector("footer");
      const cs = container ? getComputedStyle(container) : null;
      return {
        mainCount: mains.length,
        mainIsAncestorOfContent: !!(main && main.querySelector("h1")),
        footerInsideMain: !!(main && footer && main.contains(footer)),
        containerMaxWidth: cs ? cs.maxWidth : null,
        containerPadLeft: cs ? cs.paddingLeft : null,
        containerPadTop: cs ? cs.paddingTop : null,
      };
    });
  }, { url: ENTRY });
}

for (const [label, path, maxW, padPx] of PAGES) {
  for (const width of [375, 1280]) {
    const m = await measure(width, label, path);
    // RULING 146: exactly one, and it must actually wrap the page content.
    rec(width, label, "exactly one <main>", m.mainCount, 1, m.mainCount === 1);
    rec(width, label, "<main> wraps the page h1", m.mainIsAncestorOfContent, true, m.mainIsAncestorOfContent);
    // Legacy keeps the footer a sibling of the page content, never inside main.
    // GUARDED on main existing: with zero <main> this read `!false === true` and
    // passed vacuously on all ten runs while the landmark was absent, which is
    // ruling 89's empty-set problem inside the instrument.
    rec(width, label, "footer OUTSIDE <main>",
      m.mainCount === 0 ? "vacuous, no main" : !m.footerInsideMain,
      true, m.mainCount > 0 && !m.footerInsideMain);
    if (width === 1280) {
      rec(width, label, "container max-width", m.containerMaxWidth, `${maxW}px`, m.containerMaxWidth === `${maxW}px`);
      rec(width, label, "container padding-left", m.containerPadLeft, `${padPx}px`, m.containerPadLeft === `${padPx}px`);
    }
  }
}

let bad = 0;
console.log("width  page                     ok    claim                          got / want");
console.log("-".repeat(104));
for (const r of rows) {
  if (!r.ok) bad++;
  console.log(
    `${String(r.w).padStart(5)}  ${r.page.padEnd(24)} ${r.ok ? "PASS" : "FAIL"}  ${r.claim.padEnd(29)} ${r.got} / ${r.want}`,
  );
}
console.log(`\n${rows.length} assertions, ${bad} failing`);
if (bad) process.exit(1);
