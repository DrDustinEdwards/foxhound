import { DurableObject } from "cloudflare:workers";

import { checkRateLimitWindow, type RateLimitOutcome } from "~/lib/http/rate-limit-window";

// Fixed-window rate limiter Durable Object (TASK-foxhound-do-rate-limiter.md,
// replaces the Cloudflare unsafe ratelimit binding: correctly configured,
// invoked, and keyed - proven via deployed diagnostic tail logs - yet
// .limit() returned {success:true} unconditionally at 35+ requests past the
// limit, same colo, spaced requests; an open-beta API with no observability
// from our side, not debuggable). Addressed by idFromName(`${bucket}:${key}`)
// (bucket in {"auth","public"}, key = client IP; app/lib/http/rate-limit.ts),
// so every request sharing a bucket+IP hits the same instance and shares one
// counter; storage is per-instance, so different buckets/IPs can never
// cross-contaminate by construction, unlike a shared external binding.
//
// The window algorithm itself lives in app/lib/http/rate-limit-window.ts
// (pure, unit-tested); this class is a thin adapter, mirroring
// workers/money-writer.ts's SerialMoneyCommitter pattern.
export class RateLimiterDurableObject extends DurableObject<Env> {
  /** Check and record one hit against a fixed window of periodMs, capped at limit. */
  check(limit: number, periodMs: number): Promise<RateLimitOutcome> {
    return checkRateLimitWindow(
      {
        getWindow: () => this.ctx.storage.get("window"),
        putWindow: (window) => this.ctx.storage.put("window", window),
      },
      Date.now(),
      limit,
      periodMs,
    );
  }
}
