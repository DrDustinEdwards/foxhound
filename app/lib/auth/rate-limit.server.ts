import { ipKey, limit, matchRule, mustStop } from "@dustinedwards/site-runtime/rate-limit";
import { data } from "react-router";

// The sign-in and signup limiter, from site-runtime (Q5, Dustin "yes",
// 2026-10-14, message cmsg_01Nd8kh3hkgYNYpWXrNkvBQLC6A6GvHRyQ6YQF4rboRtgK;
// RULES.md 4.10). It replaces Foxhound's own auth bucket in
// app/lib/http/rate-limit.ts, which matched paths in workers/app.ts.
//
// WHY IN THE ACTIONS, NOT IN FRONT OF THE ROUTER. The old guard matched the
// path a request named. A hydrated browser submits a form to "/login.data"
// (react-router's single fetch adds the suffix), which that matcher never
// matched, so every sign-in from the page's own form went through unthrottled.
// A route's action runs whatever URL reached it, so the check cannot be spelt
// around, and a refusal can be shown in the page's own alert in Recova's words
// instead of a bare 429.
//
// THE LIMITS, unchanged (RULES.md 4.10, "limits as the ledger set them"):
// - every signed-out POST that can test a password or send mail shares one
//   bucket of 10 a minute per IP, as Foxhound's auth bucket did. Recova's
//   RATE_LIMIT_LOGIN is the same 10 a minute (lib/constants.ts line 109).
// - a signup also spends ruling 24's bucket of 5 an hour per IP, Recova's
//   RATE_LIMIT_SIGNUP (lib/constants.ts line 108), checked after the shared one
//   so a request the shared bucket refuses does not spend an hourly signup.
//
// A failing counter lets the request through (onUnavailable "allow"): RULES.md
// 4.10, "fails open by design", because a Durable Object hiccup must never lock
// a merchant out of signing in. site-runtime logs that case as one line naming
// the bucket only, never the address, the email or the password.

/** 10 a minute per IP, every credential or mail POST. */
export const AUTH_RULES = [{ limit: 10, windowSeconds: 60 }];
/** Ruling 24: 5 signups an hour per IP. */
export const SIGNUP_RULES = [{ limit: 5, windowSeconds: 60 * 60 }];

/** Recova's words for a refused sign-in (app/api/auth/login/route.ts line 11). */
export const SIGN_IN_LIMITED = "Too many attempts. Please try again in a minute.";
/** Recova's words for a refused signup (app/api/auth/signup/route.ts line 14). */
export const SIGN_UP_LIMITED = "Too many requests. Please try again later.";

const ON_UNAVAILABLE = "allow" as const;

export type AuthAttempt = "credential" | "signup";

/** site-runtime's verdict for the bucket that refused. */
export type AuthLimitRefusal = Awaited<ReturnType<typeof limit>>;

/**
 * Spends one use of the caller's auth budget, and of the signup budget for a
 * signup. Returns the refusal when either is spent, or null to go on. Call it
 * first in the action, before the form is read or Better Auth is called.
 */
export async function checkAuthLimit(
  env: Env,
  request: Request,
  attempt: AuthAttempt,
): Promise<AuthLimitRefusal | null> {
  const shared = await limit(env.AUTH_RATE_LIMITER, ipKey("auth", request).key, AUTH_RULES, {
    onUnavailable: ON_UNAVAILABLE,
  });
  if (mustStop(shared, ON_UNAVAILABLE)) return shared;
  if (attempt !== "signup") return null;

  const signup = await limit(env.AUTH_RATE_LIMITER, ipKey("signup", request).key, SIGNUP_RULES, {
    onUnavailable: ON_UNAVAILABLE,
  });
  if (mustStop(signup, ON_UNAVAILABLE)) return signup;
  return null;
}

/** Where a refused Google start sends the browser: back to the login page,
 *  which shows SIGN_IN_LIMITED for this code (Recova's ?error= mechanism,
 *  app/(auth)/login/page.tsx). */
export const RATE_LIMITED_ERROR = "rate_limited";

/** The action's answer to a refusal: 429 with Retry-After, and the words the
 *  page shows in its alert. */
export function limitedData<T extends { error: string }>(body: T, refusal: AuthLimitRefusal) {
  return data(body, {
    status: 429,
    headers: { "Retry-After": String(refusal.retryAfterSeconds) },
  });
}

/** Better Auth's own sign-up endpoints under /api/auth, which spend the signup
 *  bucket like the page does. Matched as the router sees the path. */
const API_SIGN_UP = [{ path: "/api/auth/sign-up", prefix: true, methods: ["POST"] }];

/** Which budget a POST to Better Auth's HTTP surface spends. */
export function apiAuthAttempt(request: Request): AuthAttempt {
  return matchRule(request, API_SIGN_UP) ? "signup" : "credential";
}
