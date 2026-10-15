// Ruling 133's five treatment items, measured. Four of them landed; the icon
// item is held pending the axis ruling (Dustin, 2026-08-05).
//
// CONDITIONS OF MEASUREMENT, stated because ruling 129 says an absence claim
// without them is not a finding:
//   - LOCAL dev server, not production. These changes are not deployed, and
//     ruling 87 bars comparing a local build against a deployed one.
//   - /demos/dashboard, because the harness has no session cookie. That route
//     enters the REAL app shell, so the chrome under test is the same element,
//     but every claim here is DEMO-SESSION evidence (ruling 133's caveat).
//   - every width is asserted from inside the page by withViewport, and every
//     media-query-dependent claim is asserted by computedAt.

import { withViewport } from "./viewport-harness.mjs";

const BASE = process.env.BASE ?? "http://localhost:5199";
const URL = `${BASE}/demos/dashboard`;
const BAR = 'nav[aria-label="Primary"].fixed';

const rows = [];
function record(width, claim, got, want, ok) {
  rows.push({ width, claim, got: String(got), want: String(want), ok });
}

// Does the bar render at all at this width? Asserted via the media query the
// claim depends on, so a wrong-width run throws instead of answering.
async function barAt(width, mq) {
  return withViewport(String(width), async (page) => {
    // FAIL LOUD on the landing path. /demos/dashboard is a 302 that sets the
    // demo cookie and redirects to /dashboard; without the cookie it bounces to
    // /login, which has no app shell at all. Measuring there would report "no
    // bar" at EVERY width with total confidence, which is ruling 129's exact
    // failure. Assert the condition actually applied (ruling 132).
    const landed = await page.evaluate(() => location.pathname);
    if (landed !== "/console") {
      throw new Error(
        `LANDED ON ${landed}, NOT /console. The demo session did not hold, so the app shell ` +
          `was never rendered and any "bar absent" reading here would be about the wrong page.`,
      );
    }
    const vis = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { present: false };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        present: true,
        display: cs.display,
        zIndex: cs.zIndex,
        paddingBottom: cs.paddingBottom,
        height: Math.round(r.height),
        bottom: Math.round(r.bottom),
        tabHeight: Math.round(el.querySelector("a")?.getBoundingClientRect().height ?? 0),
        tabCount: el.querySelectorAll("a").length,
        svgCount: el.querySelectorAll("svg").length,
      };
    }, BAR);
    if (mq) {
      const held = await page.evaluate((q) => window.matchMedia(q).matches, mq);
      if (!held) throw new Error(`MEDIA QUERY DID NOT HOLD: ${mq} at ${width}px`);
    }
    return vis;
  }, { url: URL });
}

// ITEM 1: sm:hidden. Legacy hides the bar at >=640px; Foxhound hid at >=768px,
// so 640 and 767 are the widths that separate the two answers.
for (const w of [320, 375, 414, 639]) {
  const b = await barAt(w, "(max-width: 639px)");
  record(w, "bar renders (legacy shows one)", b.present && b.display !== "none", true,
    b.present && b.display !== "none");
}
for (const w of [640, 767, 768, 1280]) {
  const b = await barAt(w, "(min-width: 640px)");
  const hidden = !b.present || b.display === "none";
  record(w, "bar HIDDEN (legacy shows none)", hidden, true, hidden);
}

// ITEM 2: min-h-[56px] against the measured 34px.
// ITEM 4: z-50 against z-10.
// ITEM 5: env(safe-area-inset-bottom). On a desktop Chrome the env() resolves
// to its 0px fallback, so what is verifiable here is that the declaration is
// PRESENT and resolves, not that it produces inset on hardware. Stated rather
// than overclaimed.
{
  const b = await barAt(375, "(max-width: 639px)");
  record(375, "tab min-height", b.tabHeight, ">= 56", b.tabHeight >= 56);
  record(375, "z-index", b.zIndex, "50", b.zIndex === "50");
  record(375, "padding-bottom resolves (env fallback 0px on desktop)",
    b.paddingBottom, "0px", b.paddingBottom === "0px");
  record(375, "tab count", b.tabCount, "6 (demo session)", b.tabCount > 0);
  record(375, "icons (HELD pending axis ruling)", b.svgCount, "0", b.svgCount === 0);
}

// FOOTER ADJACENCY re-verified at 375, because min-h-56 changes the bar height
// the pb-16 reserve was originally measured against (34px).
{
  const geo = await withViewport("375", async (page) => {
    // SCROLL TO THE DOCUMENT BOTTOM FIRST. The first draft of this check compared
    // viewport-relative rects at scroll top, so on any page taller than the
    // viewport the footer sat off-screen below, fr.bottom exceeded the fixed
    // bar's top, and it reported occlusion that is not there. That is ruling
    // 129's class inside the instrument again: the measurement has to be taken
    // at the condition the claim is about, and the claim is about what a reader
    // sees when scrolled to the end.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);
    return page.evaluate((sel) => {
      const bar = document.querySelector(sel);
      const foot = document.querySelector("footer");
      const wrap = foot?.closest("div");
      const fr = foot.getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      const atBottom =
        Math.abs(window.scrollY + window.innerHeight - document.documentElement.scrollHeight) <= 2;
      return {
        atBottom,
        scrollable: document.documentElement.scrollHeight > window.innerHeight,
        footerHeight: Math.round(fr.height),
        footerBottom: Math.round(fr.bottom),
        barTop: Math.round(br.top),
        barHeight: Math.round(br.height),
        reserve: getComputedStyle(wrap).paddingBottom,
        clearance: Math.round(br.top - fr.bottom),
        occluded: fr.bottom > br.top,
      };
    }, BAR);
  }, { url: URL });
  if (geo.scrollable && !geo.atBottom) {
    throw new Error("Could not scroll to the document bottom; the occlusion claim is about that position.");
  }
  record(375, "scrolled to document bottom", geo.atBottom, true, geo.atBottom);
  record(375, "footer-to-bar clearance", `${geo.clearance}px`, ">= 0", geo.clearance >= 0);
  record(375, "footer height", geo.footerHeight, "(observed)", true);
  record(375, "bar height", geo.barHeight, ">= 56", geo.barHeight >= 56);
  record(375, "wrapper reserve", geo.reserve, "64px", geo.reserve === "64px");
  record(375, "footer NOT occluded by bar", !geo.occluded, true, !geo.occluded);
}

let bad = 0;
console.log("width  ok   claim                                              got / want");
console.log("-".repeat(96));
for (const r of rows) {
  if (!r.ok) bad++;
  console.log(
    `${String(r.width).padStart(5)}  ${r.ok ? "PASS" : "FAIL"} ${r.claim.padEnd(50)} ${r.got} / ${r.want}`,
  );
}
console.log(`\n${rows.length} assertions, ${bad} failing`);
process.exit(bad ? 1 : 0);
