// The fixed-window rate-limit core (TASK-foxhound-do-rate-limiter.md,
// replaces the Cloudflare unsafe ratelimit binding: correctly configured,
// invoked, and keyed, but .limit() returned {success:true} unconditionally
// live in production past every configured limit - an open-beta API with no
// observability from our side, not debuggable, and now not trusted for
// this). Pure and dependency-injected so it is unit-testable without the
// Workers runtime; the Durable Object (workers/rate-limiter.ts) is a thin
// adapter supplying real DO-storage get/put, mirroring
// app/lib/money/serializer.ts's SerialMoneyCommitter pattern.
//
// One {count, windowStart} record per DO instance (one instance per
// bucket:key, app/lib/http/rate-limit.ts). A hit either falls inside the
// current window (increment) or the window has elapsed (reset to a fresh
// window starting now). No alarm needed: a stale window is simply
// overwritten by the next hit, and idle instances hibernate in between.

export interface RateLimitWindow {
  count: number;
  windowStart: number;
}

export interface RateLimitOutcome {
  allowed: boolean;
  retryAfterSec: number;
}

/** Injected storage side effects. Real impl lives in the DO. */
export interface RateLimitWindowDeps {
  getWindow(): Promise<RateLimitWindow | undefined>;
  putWindow(window: RateLimitWindow): Promise<void>;
}

export async function checkRateLimitWindow(
  deps: RateLimitWindowDeps,
  now: number,
  limit: number,
  periodMs: number,
): Promise<RateLimitOutcome> {
  const existing = await deps.getWindow();
  const window: RateLimitWindow =
    existing && now - existing.windowStart < periodMs ? existing : { count: 0, windowStart: now };

  window.count += 1;
  await deps.putWindow(window);

  return {
    allowed: window.count <= limit,
    retryAfterSec: Math.ceil((window.windowStart + periodMs - now) / 1000),
  };
}
