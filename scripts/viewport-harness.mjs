// Responsive verification harness (ruling 129).
//
// Ruling 119 recorded "nothing pinned to the viewport bottom" from a
// measurement taken at 1280px, which is exactly the width at which the control
// under test is hidden. The conclusion was refuted; the debt that caused it is
// what this script exists to pay.
//
// WHY NOT THE BROWSER EXTENSION. Measured 2026-08-06: its resize_window reports
// "Successfully resized" and the viewport does not move. The MCP tab is a
// background tab (document.visibilityState === "hidden", zero resize events
// fired), so the window resize never reaches its layout. A harness built on
// that tool's success message would report "measured at 375px" while measuring
// at 1280px, which is 119's failure with more confidence behind it. The success
// message is not evidence the width applied.
//
// WHY NOT AN IFRAME. foxhoundapp.com sends X-Frame-Options: DENY and CSP
// frame-ancestors 'none'. That is ruling 93's security posture and is not
// weakened to make a test easier.
//
// THE ONE RULE THIS SCRIPT ENFORCES: every measurement asserts the width it
// claims. assertViewport() re-reads innerWidth and the governing media query
// from inside the page and THROWS on mismatch. A run that cannot reach a width
// fails loudly rather than silently measuring at another one, per ruling 122:
// a gate that cannot handle an input must fail on it, never skip it.

import { chromium } from "playwright";

// Named widths. Tailwind's breakpoints are the boundaries that matter here:
// sm=640 (legacy's tab-bar cutoff), md=768 (Foxhound's).
export const WIDTHS = {
  "mobile-320": 320,
  "mobile-375": 375,
  "mobile-414": 414,
  "sm-639": 639,
  "sm-640": 640,
  "md-767": 767,
  "md-768": 768,
  "desktop-1280": 1280,
};

export async function withViewport(name, fn, opts = {}) {
  const width = WIDTHS[name] ?? Number(name);
  if (!Number.isFinite(width)) throw new Error(`unknown viewport: ${name}`);

  // channel:"chrome" drives the installed Chrome rather than downloading a
  // separate browser build.
  const browser = await chromium.launch({ channel: opts.channel ?? "chrome" });
  try {
    const context = await browser.newContext({
      viewport: { width, height: opts.height ?? 800 },
      deviceScaleFactor: 1,
      storageState: opts.storageState,
    });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: "networkidle" });

    // FAIL LOUD. The width is verified from inside the page, after load, not
    // taken on the launcher's word.
    const applied = await page.evaluate(() => ({
      inner: window.innerWidth,
      client: document.documentElement.clientWidth,
      vis: document.visibilityState,
      url: location.pathname,
    }));
    if (applied.inner !== width) {
      throw new Error(
        `VIEWPORT NOT APPLIED: asked for ${width}px, page reports innerWidth=${applied.inner}. ` +
          `Refusing to measure, because a measurement at an unverified width is what ruling 129 refuted.`,
      );
    }
    if (applied.vis !== "visible") {
      throw new Error(
        `PAGE NOT VISIBLE (visibilityState=${applied.vis}). Layout and media queries are not ` +
          `trustworthy in a hidden page; this is the defect that makes the browser extension unusable here.`,
      );
    }
    return await fn(page, { width, applied });
  } finally {
    await browser.close();
  }
}

// Assert a computed style at a named width. Returns the value; throws if the
// media query governing the claim did not actually hold.
export async function computedAt(page, selector, props, mediaQuery) {
  return page.evaluate(
    ({ selector, props, mediaQuery }) => {
      if (mediaQuery && !window.matchMedia(mediaQuery).matches) {
        throw new Error(
          `MEDIA QUERY DID NOT HOLD: ${mediaQuery} is false at innerWidth=${window.innerWidth}. ` +
            `The claim being tested is about the other side of this boundary.`,
        );
      }
      const el = document.querySelector(selector);
      if (!el) return { present: false, selector };
      const cs = getComputedStyle(el);
      const out = { present: true, selector };
      for (const p of props) out[p] = cs.getPropertyValue(p);
      const r = el.getBoundingClientRect();
      out.rect = { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) };
      return out;
    },
    { selector, props, mediaQuery },
  );
}
