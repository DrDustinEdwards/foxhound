import { ipKey, limit, mustStop } from "@dustinedwards/site-runtime/rate-limit";
import { data } from "react-router";

// The sign-in and signup limiter, from site-runtime. It replaces Foxhound's own
// auth bucket in app/lib/http/rate-limit.ts, which matched paths in
// workers/app.ts.
//
// A hydrated browser submits a form to "/login.data" (react-router's single
// fetch adds the suffix), which that matcher never matched, so every sign-in
// from the page's own form went through unthrottled.

/** 10 a minute per IP, every credential or mail POST. */
const AUTH_RULES = [{ limit: 10, windowSeconds: 60 }];
/** Ruling 24: 5 signups an hour per IP. */
const SIGNUP_RULES = [{ limit: 5, windowSeconds: 60 * 60 }];

export const SIGN_IN_LIMITED = "Too many attempts. Please try again in a minute.";
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

export const RATE_LIMITED_ERROR = "rate_limited";

/**
 * The action's answer to a refusal: 429 with Retry-After, and the words the
 * page shows in its alert.
 */
export function limitedData<T extends { error: string }>(body: T, refusal: AuthLimitRefusal) {
  return data(body, {
    status: 429,
    headers: { "Retry-After": String(refusal.retryAfterSeconds) },
  });
}
