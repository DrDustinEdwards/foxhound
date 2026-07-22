// Cloudflare Rate Limiting binding enforcement, keyed on cf-connecting-ip
// (ARCHITECTURE.md's "Cloudflare rate limiting binding, keyed on
// cf-connecting-ip" mandate; audit finding M-1, foxhound-audit-security.md:
// /api/auth/* was live-verified unthrottled, 8 rapid sign-in POSTs all
// returned 401 with no 429). Do NOT rely on Better Auth's built-in in-memory
// limiter: it is per-isolate, so it does not bind across the isolate pool a
// Worker actually runs on (M-1).
//
// resolveRateLimitBinding is a pure path/method matcher, kept separate from
// the binding call itself, so both are independently unit-testable (path
// matching with plain requests; the 429 outcome with a mock RateLimit
// binding), without needing a live Workers rate-limiting binding.
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

const RETRY_AFTER_SECONDS = 60; // matches both bindings' fixed 60s window

export function resolveRateLimitBinding(request: Request, env: Env): RateLimit | null {
  if (request.method !== "POST") return null;
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/auth/")) return env.RATE_LIMIT_AUTH;
  if (pathname === "/demos" || pathname === "/audit") return env.RATE_LIMIT_PUBLIC;
  return null;
}

export function rateLimitedResponse(retryAfterSeconds: number = RETRY_AFTER_SECONDS): Response {
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
 * Check the request against whichever rate-limit binding applies, and return
 * the 429 response to send if it is over budget, or null if the request
 * should proceed. Call this BEFORE the route handler runs (workers/app.ts
 * fetch), so a throttled request never reaches a sign-in DB lookup or
 * dispatches a password-reset/verification email.
 */
export async function enforceRateLimit(request: Request, env: Env): Promise<Response | null> {
  const binding = resolveRateLimitBinding(request, env);
  if (!binding) return null;

  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await binding.limit({ key });
  if (success) return null;
  return rateLimitedResponse(RETRY_AFTER_SECONDS);
}
