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

  it("computes retryAfterSec as the remaining window time, rounded up", async () => {
    const { deps } = makeStorage();
    const now = 1_000_000;
    await checkRateLimitWindow(deps, now, 10, 60_000);
    const outcome = await checkRateLimitWindow(deps, now + 15_000, 10, 60_000);
    // 60_000ms period - 15_000ms elapsed = 45_000ms = 45s remaining.
    expect(outcome.retryAfterSec).toBe(45);
  });
});
