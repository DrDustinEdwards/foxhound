// Rate-limit enforcement, keyed on cf-connecting-ip (ARCHITECTURE.md's
// "Cloudflare rate limiting binding, keyed on cf-connecting-ip" mandate).
//
// M-1 WAS NOT CLOSED BY THE ORIGINAL VERSION OF THIS FILE, and the header that
// used to sit here said it was. Audit finding M-1
// (foxhound-audit-security.md) live-verified /api/auth/* unthrottled, so this
// matcher was built against /api/auth/ and stopped there. But Foxhound does
// not sign anyone in over /api/auth/: login.tsx, signup.tsx,
// forgot-password.tsx and reset-password.tsx each POST to their OWN route and
// call Better Auth as an in-process method (getAuth(env).api.signInEmail and
// friends), so the Durable Object never saw a sign-in, a stuffed credential
// list, or a reset-mail bomb. The guard was real and it was pointed at a tree
// nothing walks. Found by the 2026-08-26 Grok 4.6 audit, scored as ruling 376
// item (1), closed here.
//
// WHAT COUNTS AS AN AUTH POST, and why the line is drawn where it is.
// AUTH_ACTION_PATHS is every route under app/routes/auth whose action calls a
// Better Auth CREDENTIAL or MAIL method in-process. getSession() also goes
// through getAuth(env).api, but it is the session READ every authenticated
// loader in the app performs, so "touches getAuth().api" would mean throttling
// the whole app; /connect and /invite/:token reach only that read, both
// already require a session, and both stay out. If a new route under
// app/routes/auth calls an api.* method other than getSession, its path
// belongs in the set below.
//
// THE MATCHER MUST NORMALIZE THE WAY THE ROUTER DOES, or it is bypassable by
// spelling. React Router matches on a DECODED pathname
// (router/utils.js matchRoutes, decodePath), with a case-insensitive regexp
// (compilePath: caseSensitive defaults false) that tolerates trailing slashes
// (compilePath appends "\/*$"), while this function sees the raw
// URL.pathname. Measured against the installed react-router 8.2.0: POST
// /LOGIN, POST /login///, and POST /%4COGIN/// all reach login.tsx's action,
// and POST /api/auth (no trailing slash) reaches the Better Auth handler
// through the splat. So an equality test on the raw path is three bypasses
// wide, and the SHIPPED /api/auth/ rule was already two of them. routedPath
// below mirrors decodePath exactly, %2F re-escaping included, so the limiter
// and the router agree on what a request is addressing.
//
// resolveRateLimitBinding is a pure path/method matcher, kept separate from
// the DO call itself, so both are independently unit-testable (path matching
// with plain requests; the 429 outcome with a mock DO stub), without needing
// a live Workers runtime.
//
// Do NOT rely on Better Auth's built-in in-memory limiter: it is per-isolate,
// so it does not bind across the isolate pool a Worker actually runs on (M-1).
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
// Scope is POST only on every surface. /api/auth/* also serves GET (session
// checks the app-shell middleware's server-side getSession() calls as a direct
// in-process Better Auth method call, not an HTTP hit to this route; but the
// browser's own client-side session polling and email verification-link clicks
// DO hit this route as GET) - throttling those at 10/min would break
// legitimate traffic for no abuse-resistance gain, since the actual threat
// (credential stuffing, password-reset/verification-email bombing) is
// inherently POST. The auth routes above are the same shape: GET renders the
// form, POST is the credential or mail action. /demos and /audit are
// single-route pages where GET renders the marketing page and POST is the
// enter/estimate action; only the action is an abuse surface.

export interface RateLimitRule {
  bucket: "auth" | "public";
  limit: number;
  periodMs: number;
}

/** Every path under app/routes/auth whose action calls a Better Auth
 *  credential or mail method in-process. Lowercase, no trailing slash: compare
 *  against routedPath(), never against a raw URL.pathname. */
const AUTH_ACTION_PATHS = new Set([
  "/login", // login.tsx -> api.signInEmail
  "/signup", // signup.tsx -> api.signUpEmail
  "/forgot-password", // forgot-password.tsx -> api.requestPasswordReset
  "/reset-password", // reset-password.tsx -> api.resetPassword
  "/auth/google", // google-start.ts -> api.signInSocial
  "/logout", // logout.ts -> api.signOut
]);

/** Marketing pages whose POST is the enter/estimate action. */
const PUBLIC_ACTION_PATHS = new Set(["/demos", "/audit"]);

/** The Better Auth HTTP surface, mounted as the splat route "api/auth/*". The
 *  splat matches with an EMPTY remainder, so /api/auth itself is routed there
 *  and the prefix test has to accept it with and without the slash. */
const API_AUTH_PREFIX = "/api/auth";

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
  const pathname = routedPath(new URL(request.url).pathname);
  if (pathname === API_AUTH_PREFIX || pathname.startsWith(`${API_AUTH_PREFIX}/`)) {
    return { bucket: "auth", limit: 10, periodMs: 60_000 };
  }
  if (AUTH_ACTION_PATHS.has(pathname)) return { bucket: "auth", limit: 10, periodMs: 60_000 };
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
