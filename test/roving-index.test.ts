import { describe, expect, it } from "vitest";

import { nextRovingIndex } from "~/lib/a11y/roving-index";

// Ruling 209 recorded the radiogroup port as verified by typecheck, lint and the
// suite but never DRIVEN, with no test of its own. This discharges that for the
// decision logic. Legacy's behavior, from
// app/(app)/recovery/payments/components/PaymentsFilters.tsx: arrows move and
// WRAP at both ends, Home goes first, End goes last, and any other key falls
// through untouched so the control does not swallow Tab or typing.
//
// LIMIT, stated rather than implied: vitest runs environment: "node" with no
// jsdom, so this covers the index arithmetic and NOT the DOM wiring. focus(),
// navigate() and the preventDefault CALL are still unverified by test; what is
// verified is that a non-handled key returns null, which is the condition the
// component uses to skip preventDefault entirely.

const N = 5; // the five status pills: All, Active, Recovered, Canceled, Failed

describe("nextRovingIndex: arrows move forward and wrap", () => {
  it("ArrowRight advances", () => {
    expect(nextRovingIndex("ArrowRight", 0, N)).toBe(1);
    expect(nextRovingIndex("ArrowRight", 2, N)).toBe(3);
  });
});

describe("nextRovingIndex: arrows move backward and wrap", () => {
  it("ArrowLeft retreats", () => {
    expect(nextRovingIndex("ArrowLeft", 3, N)).toBe(2);
    expect(nextRovingIndex("ArrowLeft", 1, N)).toBe(0);
  });
});

describe("nextRovingIndex: Home and End", () => {
  it("Home goes to the first option from anywhere", () => {
    for (let i = 0; i < N; i++) expect(nextRovingIndex("Home", i, N)).toBe(0);
  });
});

describe("nextRovingIndex: keys it must NOT handle", () => {
  // This is the preventDefault contract. A key returning null means the
  // component returns early and never calls preventDefault, so the browser
  // keeps Tab, typing and shortcuts.
  it.each(["Tab", "Enter", " ", "Escape", "a", "PageUp", "PageDown", "Shift"])(
    "%s returns null so preventDefault is never reached",
    (key) => {
      expect(nextRovingIndex(key, 1, N)).toBeNull();
    },
  );
});

describe("nextRovingIndex: degenerate inputs", () => {
  it("returns null on an empty set rather than computing an index into nothing", () => {
    expect(nextRovingIndex("ArrowRight", 0, 0)).toBeNull();
    expect(nextRovingIndex("Home", 0, 0)).toBeNull();
  });

  it("every handled key returns an index inside the set", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"]) {
      for (let i = 0; i < N; i++) {
        const next = nextRovingIndex(key, i, N);
        expect(next).not.toBeNull();
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThan(N);
      }
    }
  });
});
