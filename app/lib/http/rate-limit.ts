// Rate-limit enforcement, keyed on cf-connecting-ip (ARCHITECTURE.md's
// "Cloudflare rate limiting binding, keyed on cf-connecting-ip" mandate;
// audit finding M-1, foxhound-audit-security.md: /api/auth/* was
// live-verified unthrottled, 8 rapid sign-in POSTs all returned 401 with no
// 429). Do NOT rely on Better Auth's built-in in-memory limiter: it is
// per-isolate, so it does not bind across the isolate pool a Worker actually
// runs on (M-1).
//
// Originally built on Cloudflare's unsafe ratelimit binding
// (TASK-foxhound-auth-rate-limit.md); replaced with a Durable Object we own
// (workers/rate-limiter.ts, TASK-foxhound-do-rate-limiter.md) after the
// binding was proven - via deployed diagnostic tail logs - to be correctly
// configured, invoked, and keyed, yet returned {success:true}
// unconditionally live in production past every configured limit. Open-beta
// API, no observability from our side, not debuggable: replaced rather than
// chased.
//
// resolveRateLimitBinding is a pure path/method matcher, kept separate from
// the DO call itself, so both are independently unit-testable (path matching
// with plain requests; the 429 outcome with a mock DO stub), without needing
// a live Workers runtime.
//
// Scope is POST only on all three surfaces. /api/auth/* also serves GET
// (session checks the app-shell middleware's server-side getSession() calls
// as a direct in-process Better Auth method call, not an HTTP hit to this
// route; but the browser's own client-side session polling and email
// verification-link clicks DO hit this route as GET) - throttling those at
// 10/min would break legitimate traffic for no abuse-resistance gain, since
// the actual threat (credential stuffing, password-reset/verification-email
// bombing) is inherently POST. /demos and /audit are single-route pages
// where GET renders the marketing page and POST is the enter/estimate
// action; only the action is an abuse surface.

export interface RateLimitRule {
  bucket: "auth" | "public";
  limit: number;
  periodMs: number;
}

export function resolveRateLimitBinding(request: Request): RateLimitRule | null {
  if (request.method !== "POST") return null;
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/auth/")) return { bucket: "auth", limit: 10, periodMs: 60_000 };
  if (pathname === "/demos" || pathname === "/audit") return { bucket: "public", limit: 20, periodMs: 60_000 };
  return null;
}

export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please try again shortly." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

/**
 * Low-level per-key check against the same RateLimiterDurableObject, for a
 * route action that needs to react to "over limit" itself instead of the
 * raw 429 Response enforceRateLimit returns (TASK-foxhound-demo-entry-parity.md
 * item 3: the home email generator falls back to a static sample rather than
 * surfacing an error, so it checks its own budget inside the action). Fails
 * open exactly like enforceRateLimit, for the same reason.
 */
export async function isWithinRateLimit(
  env: Env,
  bucket: string,
  key: string,
  limit: number,
  periodMs: number,
): Promise<boolean> {
  try {
    const ns = env.RATE_LIMITER;
    const stub = ns.get(ns.idFromName(`${bucket}:${key}`));
    const { allowed } = await stub.check(limit, periodMs);
    return allowed;
  } catch (err) {
    console.error("RateLimiterDurableObject check failed; allowing request", err);
    return true;
  }
}

/**
 * Check the request against whichever rate-limit rule applies, and return
 * the 429 response to send if it is over budget, or null if the request
 * should proceed. Call this BEFORE the route handler runs (workers/app.ts
 * fetch), so a throttled request never reaches a sign-in DB lookup or
 * dispatches a password-reset/verification email.
 *
 * Fail-open: if the Durable Object call throws (RPC failure, DO outage), the
 * request is allowed through. Availability over strictness on the auth path
 * - a DO hiccup must never lock a legitimate user out of sign-in.
 */
export async function enforceRateLimit(request: Request, env: Env): Promise<Response | null> {
  const rule = resolveRateLimitBinding(request);
  if (!rule) return null;

  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    const ns = env.RATE_LIMITER;
    const stub = ns.get(ns.idFromName(`${rule.bucket}:${key}`));
    const { allowed, retryAfterSec } = await stub.check(rule.limit, rule.periodMs);
    if (allowed) return null;
    return rateLimitedResponse(retryAfterSec);
  } catch (err) {
    console.error("RateLimiterDurableObject check failed; allowing request", err);
    return null;
  }
}
