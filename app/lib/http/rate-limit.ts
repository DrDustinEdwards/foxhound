// Rate-limit enforcement, keyed on cf-connecting-ip, on Foxhound's own
// fixed-window Durable Object (workers/rate-limiter.ts).
//
// THE AUTH BUCKET LEFT THIS FILE IN J52 (job_674e728b50a3). Sign-in, signup,
// password reset, the Google start and Better Auth's own /api/auth endpoints
// are limited by site-runtime's limiter inside their actions
// (app/lib/auth/rate-limit.server.ts; Q5, RULES.md 4.10). This file matched
// paths in workers/app.ts, and a hydrated form posts to "/login.data", which
// the path matcher never matched: every sign-in from the page's own form went
// unthrottled. What is left here is the public bucket and the per-caller
// checks (isWithinRateLimit) other surfaces use.
//
// THE PUBLIC BUCKET HAD THE SAME ".data" GAP: POST /demos.data and /audit.data
// reach the same actions as /demos and /audit, so resolveRateLimitBinding
// drops the ".data" suffix before matching (Grok audit 2026-10-21, FH-8).
//
// THE MATCHER MUST NORMALIZE THE WAY THE ROUTER DOES, or it is bypassable by
// spelling. React Router matches on a DECODED pathname
// (router/utils.js matchRoutes, decodePath), with a case-insensitive regexp
// (compilePath: caseSensitive defaults false) that tolerates trailing slashes
// (compilePath appends "\/*$"), while this function sees the raw
// URL.pathname. routedPath below mirrors decodePath exactly, %2F re-escaping
// included, so the limiter and the router agree on what a request is
// addressing.
//
// resolveRateLimitBinding is a pure path/method matcher, kept separate from
// the DO call itself, so both are independently unit-testable (path matching
// with plain requests; the 429 outcome with a mock DO stub), without needing
// a live Workers runtime.
//
// Originally built on Cloudflare's unsafe ratelimit binding
// (TASK-foxhound-auth-rate-limit.md); replaced with a Durable Object we own
// (workers/rate-limiter.ts, TASK-foxhound-do-rate-limiter.md) after the
// binding was proven - via deployed diagnostic tail logs - to be correctly
// configured, invoked, and keyed, yet returned {success:true}
// unconditionally live in production past every configured limit.
//
// Scope is POST only. /demos and /audit are single-route pages where GET
// renders the marketing page and POST is the enter/estimate action; only the
// action is an abuse surface.

export interface RateLimitRule {
  bucket: "public";
  limit: number;
  periodMs: number;
}

/** Marketing pages whose POST is the enter/estimate action. */
const PUBLIC_ACTION_PATHS = new Set(["/demos", "/audit"]);

/**
 * The pathname the ROUTER will match this request on, which is not the one
 * URL.pathname reports. Mirrors react-router's decodePath (split on "/",
 * decodeURIComponent each segment, re-escape any decoded "/" as %2F so a
 * segment cannot smuggle a separator), then folds case and trailing slashes
 * the way compilePath's case-insensitive, "\/*$"-terminated regexp does.
 * A malformed percent-escape falls back to the raw value, exactly as
 * decodePath does, so the two stay in agreement on garbage input too.
 */
function routedPath(rawPathname: string): string {
  let decoded: string;
  try {
    decoded = rawPathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\//g, "%2F"))
      .join("/");
  } catch {
    decoded = rawPathname;
  }
  const trimmed = decoded.toLowerCase().replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function resolveRateLimitBinding(request: Request): RateLimitRule | null {
  if (request.method !== "POST") return null;
  const routed = routedPath(new URL(request.url).pathname);
  const pathname = routed.endsWith(".data") ? routed.slice(0, -".data".length) : routed;
  if (PUBLIC_ACTION_PATHS.has(pathname)) return { bucket: "public", limit: 20, periodMs: 60_000 };
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
 * open exactly like enforceRateLimit, for the same reason, unless the caller
 * passes { failClosed: true }: then a failed check is logged whole and thrown
 * as RateLimiterUnavailableError, so a caller whose request costs money (the
 * Intelligence report button's paid model call, J67) refuses and can say why
 * rather than calling it a rate limit. No other caller passes it.
 */
export class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super("RateLimiterDurableObject check failed", { cause });
    this.name = "RateLimiterUnavailableError";
  }
}

export async function isWithinRateLimit(
  env: Env,
  bucket: string,
  key: string,
  limit: number,
  periodMs: number,
  options: { failClosed?: boolean } = {},
): Promise<boolean> {
  try {
    const ns = env.RATE_LIMITER;
    const stub = ns.get(ns.idFromName(`${bucket}:${key}`));
    const { allowed } = await stub.check(limit, periodMs);
    return allowed;
  } catch (err) {
    if (options.failClosed) {
      console.error(`RateLimiterDurableObject check failed; refusing request (${bucket})`, err);
      throw new RateLimiterUnavailableError(err);
    }
    console.error("RateLimiterDurableObject check failed; allowing request", err);
    return true;
  }
}

/**
 * Check the request against whichever rate-limit rule applies, and return
 * the 429 response to send if it is over budget, or null if the request
 * should proceed. Call this BEFORE the route handler runs (workers/app.ts
 * fetch), so a throttled request never reaches the action.
 *
 * Fail-open: if the Durable Object call throws (RPC failure, DO outage), the
 * request is allowed through.
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
