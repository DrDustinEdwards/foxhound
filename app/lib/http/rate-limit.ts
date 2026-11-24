import { logEvent, OWASP_EVENTS, requestFields } from "@dustinedwards/site-runtime/log";
import { limit } from "@dustinedwards/site-runtime/rate-limit";
import { clientIp } from "@dustinedwards/site-runtime/http";

// Rate-limit enforcement keyed on the caller's address (site-runtime clientIp), on site-runtime's RateLimiter
// Durable Object (RATE_LIMITER, whose old class name is kept so no namespace is deleted). Auth limits live in
// their actions (app/lib/auth/rate-limit.server.ts) because a hydrated form posts to "/login.data", which a
// path matcher never matched; what is left here is the public bucket and the per-caller checks
// (isWithinRateLimit). The same ".data" gap applies to POST /demos.data and /audit.data, so
// resolveRateLimitBinding drops that suffix.
//
// The matcher must normalize the way the router does or it is bypassable by spelling: React Router matches a
// DECODED pathname, case-insensitively, tolerating trailing slashes, while this sees the raw URL.pathname.
// routedPath mirrors decodePath exactly (%2F re-escaping included). resolveRateLimitBinding is a pure
// path/method matcher, separate from the DO call, so both are unit-testable. Scope is POST only: GET on
// /demos and /audit renders the marketing page and only the action is an abuse surface. Windows are
// clock-aligned and a refused hit is not counted.

export interface RateLimitRule {
  bucket: "public";
  limit: number;
  periodMs: number;
}

const PUBLIC_ACTION_PATHS = new Set(["/demos", "/audit"]);

/** The pathname the router will match this request on: react-router's decodePath (segments decoded, a decoded "/"
 *  re-escaped as %2F), then case and trailing slashes folded. A malformed escape falls back to the raw value. */
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
  return new Response(JSON.stringify({ error: "Too many requests. Please try again shortly." }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

/** Per-key check for a route action that reacts to "over limit" itself. Fails open unless { failClosed: true }:
 *  then a failed check throws RateLimiterUnavailableError, so a request that costs money refuses rather than
 *  calling it a rate limit. site-runtime logs the failure, naming the bucket and never the key. */
class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Rate limiter check failed", { cause });
    this.name = "RateLimiterUnavailableError";
  }
}

async function check(
  env: Env,
  bucket: string,
  key: string,
  max: number,
  periodMs: number,
  failClosed: boolean,
) {
  const onUnavailable = failClosed ? "refuse" : "allow";
  const verdict = await limit(
    env.RATE_LIMITER,
    `${bucket}:${key}`,
    [{ limit: max, windowSeconds: periodMs / 1000 }],
    {
      onUnavailable,
    },
  );
  if (verdict.status === "unavailable" && failClosed)
    throw new RateLimiterUnavailableError(verdict.detail);
  return verdict;
}

export async function isWithinRateLimit(
  env: Env,
  bucket: string,
  key: string,
  max: number,
  periodMs: number,
  options: { failClosed?: boolean } = {},
): Promise<boolean> {
  return (
    (await check(env, bucket, key, max, periodMs, options.failClosed ?? false)).status !== "limited"
  );
}

/** isWithinRateLimit on the caller's address (an IPv6 address by its /64). Fails open. */
export function isIpWithinRateLimit(
  env: Env,
  request: Request,
  bucket: string,
  rule: { readonly max: number; readonly windowMs: number },
): Promise<boolean> {
  return isWithinRateLimit(env, bucket, clientIp(request), rule.max, rule.windowMs);
}

/** Check the request against the applicable rate-limit rule; return the 429 to send, or null to proceed.
 *  Called BEFORE the route handler (workers/app.ts), so a throttled request never reaches the action. Fails open. */
export async function limitPublicActions(request: Request, env: Env): Promise<Response | null> {
  const rule = resolveRateLimitBinding(request);
  if (!rule) return null;
  const key = clientIp(request);
  const verdict = await check(env, rule.bucket, key, rule.limit, rule.periodMs, false);
  if (verdict.status !== "limited") return null;
  logEvent(
    OWASP_EVENTS.rateLimitExceeded,
    { ...requestFields(request), bucket: rule.bucket },
    { level: "warn" },
  );
  return rateLimitedResponse(verdict.retryAfterSeconds);
}
