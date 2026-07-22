import { describe, expect, it } from "vitest";

import { checkRateLimitWindow, type RateLimitWindow } from "~/lib/http/rate-limit-window";

// The fixed-window algorithm itself (TASK-foxhound-do-rate-limiter.md).
// Real production code, not a mock: workers/rate-limiter.ts calls this exact
// function with real DO storage. An in-memory box stands in for storage here
// (single instance per test, matching one DO instance).

function makeStorage() {
  let window: RateLimitWindow | undefined;
  return {
    deps: {
      getWindow: async () => window,
      putWindow: async (w: RateLimitWindow) => {
        window = w;
      },
    },
    read: () => window,
  };
}

describe("checkRateLimitWindow", () => {
  it("allows requests up to the limit", async () => {
    const { deps } = makeStorage();
    const now = 1_000_000;
    for (let i = 1; i <= 10; i++) {
      const outcome = await checkRateLimitWindow(deps, now + i, 10, 60_000);
      expect(outcome.allowed).toBe(true);
    }
  });

  it("denies exactly at the boundary: request N allowed, N+1 denied", async () => {
    const { deps } = makeStorage();
    const now = 1_000_000;
    let last;
    for (let i = 1; i <= 10; i++) {
      last = await checkRateLimitWindow(deps, now + i, 10, 60_000);
    }
    expect(last!.allowed).toBe(true); // request 10 (the limit itself)

    const eleventh = await checkRateLimitWindow(deps, now + 11, 10, 60_000);
    expect(eleventh.allowed).toBe(false);
  });

  it("resets the window once periodMs has elapsed, allowing fresh requests", async () => {
    const { deps, read } = makeStorage();
    const now = 1_000_000;
    // All 10 calls share the same instant, so windowStart stays pinned at
    // `now` (only the first call establishes it; the rest reuse it).
    for (let i = 1; i <= 10; i++) {
      await checkRateLimitWindow(deps, now, 10, 60_000);
    }
    const stillDenied = await checkRateLimitWindow(deps, now + 20, 10, 60_000);
    expect(stillDenied.allowed).toBe(false);

    // Window elapses (>= periodMs since windowStart).
    const afterReset = await checkRateLimitWindow(deps, now + 60_000, 10, 60_000);
    expect(afterReset.allowed).toBe(true);
    expect(read()?.count).toBe(1);
    expect(read()?.windowStart).toBe(now + 60_000);
  });

  it("does not reset on the instant before the window elapses", async () => {
    const { deps } = makeStorage();
    const now = 1_000_000;
    for (let i = 1; i <= 10; i++) {
      await checkRateLimitWindow(deps, now, 10, 60_000);
    }
    // now - windowStart == periodMs - 1: still the same window, still denied.
    const justBefore = await checkRateLimitWindow(deps, now + 59_999, 10, 60_000);
    expect(justBefore.allowed).toBe(false);
  });

  it("computes retryAfterSec as the remaining window time, rounded up", async () => {
    const { deps } = makeStorage();
    const now = 1_000_000;
    await checkRateLimitWindow(deps, now, 10, 60_000);
    const outcome = await checkRateLimitWindow(deps, now + 15_000, 10, 60_000);
    // 60_000ms period - 15_000ms elapsed = 45_000ms = 45s remaining.
    expect(outcome.retryAfterSec).toBe(45);
  });

  it("treats a fresh (never-seen) key as an empty window", async () => {
    const { deps } = makeStorage();
    const outcome = await checkRateLimitWindow(deps, Date.now(), 1, 60_000);
    expect(outcome.allowed).toBe(true);
  });
});
