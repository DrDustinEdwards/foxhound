
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





describe("306: the splash covers legacy's whole set", () => {

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

  it("a trailing slash is the same page", () => {
    // Without normalization a stray "/recovery/dashboard/" would silently stall
    // rather than splash, which is the failure mode that looks like nothing happened.
    expect(isSplashPath("/recovery/dashboard/")).toBe(true);
    expect(isSplashPath("/settings/")).toBe(true);
    // and it must not turn a non-splash path into one
    expect(isSplashPath("/billing/")).toBe(false);
  });
});
