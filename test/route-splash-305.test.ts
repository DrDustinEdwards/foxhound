
import { describe, expect, it } from "vitest";

import { isPaymentDetailPath, shouldShowRouteSplash } from "~/lib/navigation/route-splash";

// RULING 305: legacy's loading.tsx ported as a capability (292), read at blob
// 7466b69991de78e58ce75427611240723139bfe4 rather than from any summary.
//
// COVERAGE BOUND, stated per 246 because it shapes every assertion below. This
// repo has NO DOM test environment: vitest runs `environment: "node"` and
// neither jsdom nor testing-library is installed, so a RENDERED presence check
// is unavailable. Adding either is a build decision and not an agent's, which is
// 256's reasoning about the sanitizer. So the pending-versus-settled DECISION is
// extracted into a pure predicate and proven behaviourally here, and the markup
// is proven by source. What is NOT proven is that React paints it; that rests on
// the demo probe.



const DETAIL = "/recovery/payments/dfp_46";

describe("305: the splash shows DURING a pending navigation", () => {
  it("shows while the detail loader is in flight", () => {
    // The whole point: this is the state that used to render nothing new for
    // the 210ms to 800ms the loader measured on live demo data.
    expect(shouldShowRouteSplash({ state: "loading", location: { pathname: DETAIL } })).toBe(true);
  });

  it("is GONE once the data has landed", () => {
    // Absence after data, not merely presence during. An idle navigation has no
    // location at all, which is the settled state's own shape.
    expect(shouldShowRouteSplash({ state: "idle" })).toBe(false);
    // AND the state guard is proven on its own. The line above passes even with
    // the state check removed, because idle carries no location and the path
    // check catches it: it was proving the wrong thing, which the idle-true
    // plant exposed. This case isolates the state guard by handing idle a valid
    // detail location, so only `state !== "loading"` can return false.
    expect(shouldShowRouteSplash({ state: "idle", location: { pathname: DETAIL } })).toBe(false);
  });

  it("never shows while a form is submitting", () => {
    expect(
      shouldShowRouteSplash({
        state: "submitting",
        formMethod: "POST",
        location: { pathname: DETAIL },
      }),
    ).toBe(false);
  });
});

describe("305 THE MONEY GUARD: a POST's revalidation is not a navigation", () => {
  // EXTENDED BY 306, not joined by siblings. 306 required these two to hold
  // across the extension, and extending the existing assertions is stronger than
  // adding new ones beside them: a sixth path added to the predicate without a
  // matching entry here leaves SPLASH_PATHS and this list visibly out of step,
  // where a sibling test would simply not cover it.
  const EVERY_SPLASH_PATH = [
    DETAIL,
    "/recovery/dashboard",
    "/recovery/payments",
    "/recovery/sequence",
    "/settings",
  ];

  it("does NOT splash while revalidating after an action, on ANY splash path", () => {
    // Read from the installed Navigation union: the "loading" state carries
    // `formMethod: Submission["formMethod"] | undefined`, so post-submission
    // revalidation is ALSO state "loading". Without this branch every one of the
    // five wired money intents would blank the page mid-action. This assertion
    // is the reason the predicate is not a bare state check.
    for (const pathname of EVERY_SPLASH_PATH) {
      expect(
        shouldShowRouteSplash({ state: "loading", formMethod: "POST", location: { pathname } }),
        `revalidation splashed on ${pathname}`,
      ).toBe(false);
    }
  });

  it("holds for every method a form can submit, on ANY splash path", () => {
    for (const pathname of EVERY_SPLASH_PATH) {
      for (const formMethod of ["POST", "PUT", "PATCH", "DELETE", "GET"]) {
        expect(
          shouldShowRouteSplash({ state: "loading", formMethod, location: { pathname } }),
          `${formMethod} revalidation splashed on ${pathname}`,
        ).toBe(false);
      }
    }
  });
});

describe("305: the path predicate is the detail route and nothing else", () => {
  it("matches a payment detail path", () => {
    expect(isPaymentDetailPath(DETAIL)).toBe(true);
    expect(isPaymentDetailPath("/recovery/payments/dfp_1")).toBe(true);
  });

  it("does NOT match the list, which is one segment shorter", () => {
    // The PATH predicate still excludes the list: the list is not a detail page.
    expect(isPaymentDetailPath("/recovery/payments")).toBe(false);
    // ADJUDICATED AND INVERTED BY 306, not silently flipped. This assertion's
    // second half used to read that the list does NOT splash, which was correct
    // under 305's deliberate detail-only bound and became FALSE when 306 ruled
    // the extension parity rather than divergence. It was a bounded-scope
    // assertion, not a regression guard, so it is re-pointed at the new truth
    // with the reason recorded, the same adjudication 296 applied to the stale
    // note-intent test. The live behaviour now lives in route-splash-306.
    expect(shouldShowRouteSplash({ state: "loading", location: { pathname: "/recovery/payments" } })).toBe(
      true,
    );
  });

  it("does NOT match export.csv, which returns a file rather than a page", () => {
    expect(isPaymentDetailPath("/recovery/payments/export.csv")).toBe(false);
  });

  it("does not match unrelated or deeper paths", () => {
    expect(isPaymentDetailPath("/recovery/payments/dfp_1/edit")).toBe(false);
    expect(isPaymentDetailPath("/disputes/d_1")).toBe(false);
    expect(isPaymentDetailPath("/console")).toBe(false);
  });
});
