import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isSplashPath, shouldShowRouteSplash } from "~/lib/navigation/route-splash";

// RULING 306: the splash extends from the payment detail page to legacy's WHOLE
// set, ruled parity rather than divergence. 305 had bounded it to the detail
// surface and reported the rest.
//
// The set is mapped from the eight-blob scan, not from memory. Legacy's eight
// loading.tsx segments collapse to FIVE Foxhound paths because three are DEMO
// duplicates and Foxhound serves demo at the same paths as the real app.
//
// COVERAGE BOUND, restated per 246 and 306: there is still no DOM environment
// here (vitest `environment: "node"`, no jsdom), so rendered presence during a
// real transition is not asserted. The instrument for "it shipped and can render"
// is client-chunk discrimination in the probe, and that is said plainly rather
// than implied by these source assertions.

const SPLASH = readFileSync("app/lib/navigation/route-splash.ts", "utf8");

/** Comments stripped. This file NAMES the paths it excludes while explaining
 *  why, so an exclusion assertion against raw source matches the explanation.
 *  Fifth and sixth instances of that class were caught in Session 17; the shape
 *  is standing now and applied up front rather than after a plant catches it. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SPLASH_CODE = strip(SPLASH);

/** Legacy's set, as Foxhound serves it. */
const LEGACY_SET = [
  "/recovery/dashboard",
  "/recovery/payments",
  "/recovery/payments/dfp_46",
  "/recovery/sequence",
  "/settings",
];

/** Routes legacy ships NO loading.tsx for. A splash here would be an invention. */
const NOT_LEGACY_SET = [
  "/console",
  "/disputes/dashboard",
  "/disputes/d_1",
  "/intelligence/dashboard",
  "/intelligence/churn",
  "/billing",
  "/help",
  "/recovery/winback",
  "/recovery/expiring-cards",
  "/admin",
  "/admin/merchants",
];

describe("306: the splash covers legacy's whole set", () => {
  it("splashes on every one of legacy's five Foxhound paths", () => {
    for (const pathname of LEGACY_SET) {
      expect(isSplashPath(pathname), `no splash on ${pathname}`).toBe(true);
      expect(
        shouldShowRouteSplash({ state: "loading", location: { pathname } }),
        `no splash during navigation to ${pathname}`,
      ).toBe(true);
    }
  });

  it("THE EXTENSION: the four segments 305 left out now splash", () => {
    // The load-bearing assertion of this ruling. Before 306 only the detail path
    // splashed and each of these returned false.
    for (const pathname of ["/recovery/dashboard", "/recovery/payments", "/recovery/sequence", "/settings"]) {
      expect(isSplashPath(pathname), `${pathname} did not gain the splash`).toBe(true);
    }
  });

  it("does NOT splash where legacy ships no loading.tsx", () => {
    // Legacy is the spec in both directions. The two NET-NEW recovery routes are
    // the sharp cases: a prefix match on /recovery would have swallowed them.
    for (const pathname of NOT_LEGACY_SET) {
      expect(isSplashPath(pathname), `invented a splash on ${pathname}`).toBe(false);
      expect(
        shouldShowRouteSplash({ state: "loading", location: { pathname } }),
        `invented a splash during navigation to ${pathname}`,
      ).toBe(false);
    }
  });

  it("REGRESSION GUARD: export.csv still never splashes", () => {
    // A resource route returns a file, not a page. 305 established this and the
    // extension must not have widened past it.
    expect(isSplashPath("/recovery/payments/export.csv")).toBe(false);
    expect(
      shouldShowRouteSplash({
        state: "loading",
        location: { pathname: "/recovery/payments/export.csv" },
      }),
    ).toBe(false);
  });

  it("REGRESSION GUARD: settings CHILDREN are not covered, which is the stated bound", () => {
    // Next's loading.tsx is generally understood to wrap a segment AND its
    // children, which would mean legacy splashed /settings/team too. That is
    // framework semantics this repo cannot verify from an installed source, and
    // the scan proves only which FILES exist. So the set is exactly the segments
    // that HAVE a loading.tsx. This guard pins that bound so the day someone
    // widens it, it is a decision and not a drift.
    expect(isSplashPath("/settings/team")).toBe(false);
  });

  it("a trailing slash is the same page", () => {
    // Without normalisation a stray "/recovery/dashboard/" would silently stall
    // rather than splash, which is the failure mode that looks like nothing happened.
    expect(isSplashPath("/recovery/dashboard/")).toBe(true);
    expect(isSplashPath("/settings/")).toBe(true);
    // and it must not turn a non-splash path into one
    expect(isSplashPath("/billing/")).toBe(false);
  });

  it("the paths are an EXACT set, never a prefix", () => {
    // Proven behaviourally rather than by reading the source for `new Set`: a
    // prefix implementation passes a presence check and silently covers the
    // NET-NEW routes.
    expect(isSplashPath("/recovery/winback")).toBe(false);
    expect(isSplashPath("/recoveryX")).toBe(false);
    expect(isSplashPath("/settings-other")).toBe(false);
    expect(isSplashPath("/recovery/payments/dfp_1/edit")).toBe(false);
  });

  it("the source carries no prefix-matching shortcut for the set", () => {
    // The one source-level assertion here, and it guards the shape rather than
    // the instances: a startsWith over the set would pass every behavioural test
    // above for today's routes and break the moment a NET-NEW route is added
    // under /recovery or /settings.
    expect(SPLASH_CODE).not.toMatch(/startsWith\(\s*["'`]\/recovery/);
    expect(SPLASH_CODE).not.toMatch(/startsWith\(\s*["'`]\/settings/);
  });
});
