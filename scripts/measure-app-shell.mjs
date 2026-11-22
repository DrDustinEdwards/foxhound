// Measures the <main> landmark and the app shell's containers. CONDITIONS: a LOCAL dev server, not production (a local build must not be compared to a deployed one); a DEMO session, entered through /demos/dashboard, because the harness holds no session cookie; every page measured at 375 (tab bar renders) AND 1280 (it does not). Each width is re-read from inside the page by withViewport, which throws on mismatch, and the landing path is asserted so a /login bounce cannot masquerade as "no main".

import { withViewport } from "./viewport-harness.mjs";

const BASE = process.env.BASE ?? "http://localhost:5199";
const ENTRY = `${BASE}/demos/dashboard`;

// row -> [path, expected max-width px at >=768, expected h-padding px at >=768]
const PAGES = [
  ["S2 /dashboard", "/console", 1280, 32],
  ["S3 /billing", "/billing", 720, 32],
  ["S5 /recovery/dashboard", "/recovery/dashboard", 1280, 32],
  ["S6 /recovery/payments", "/recovery/payments", 1280, 32],
  ["S9 /recovery/sequences", "/recovery/sequence", 1280, 32],
];

const rows = [];
const rec = (w, page, claim, got, want, ok) =>
  rows.push({ w, page, claim, got: String(got), want: String(want), ok });

async function measure(width, label, path) {
  return withViewport(
    String(width),
    async (page) => {
      // Enter the demo session first, then navigate: goto on the entry route sets the cookie; without it every app route 302s to /login and every landmark reading would be about the wrong page.
      const resp = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      const landed = await page.evaluate(() => location.pathname);
      if (landed !== path) {
        throw new Error(
          `LANDED ON ${landed}, NOT ${path}. The demo session did not hold, so the app shell was ` +
            `never rendered and any "no main" reading here would be about the wrong page.`,
        );
      }
      // THE PATH GUARD IS NOT ENOUGH: a 500 rendered by the root error boundary keeps location.pathname correct. So the guard asserts the response status, the mechanism, which cannot be reworded; matching body text proved worthless (the real 500 page's entire visible text is the single word "Error").
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
    },
    { url: ENTRY },
  );
}

for (const [label, path, maxW, padPx] of PAGES) {
  for (const width of [375, 1280]) {
    const m = await measure(width, label, path);
    // Exactly one <main>, and it must actually wrap the page content.
    rec(width, label, "exactly one <main>", m.mainCount, 1, m.mainCount === 1);
    rec(
      width,
      label,
      "<main> wraps the page h1",
      m.mainIsAncestorOfContent,
      true,
      m.mainIsAncestorOfContent,
    );
    // The footer is a sibling of the page content, never inside main. GUARDED on main existing: with zero <main> this read `!false === true` and passed vacuously.
    rec(
      width,
      label,
      "footer OUTSIDE <main>",
      m.mainCount === 0 ? "vacuous, no main" : !m.footerInsideMain,
      true,
      m.mainCount > 0 && !m.footerInsideMain,
    );
    if (width === 1280) {
      rec(
        width,
        label,
        "container max-width",
        m.containerMaxWidth,
        `${maxW}px`,
        m.containerMaxWidth === `${maxW}px`,
      );
      rec(
        width,
        label,
        "container padding-left",
        m.containerPadLeft,
        `${padPx}px`,
        m.containerPadLeft === `${padPx}px`,
      );
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
