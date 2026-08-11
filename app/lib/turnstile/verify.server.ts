// Cloudflare Turnstile siteverify call for the no-auth estimator (Phase 6
// Pass 3, PRICING.md: "No-auth estimator first... Turnstile-protected").
//
// Isolated seam, same discipline as app/lib/recovery/email-generation.ts's
// ANTHROPIC_API_KEY gate: `verifyTurnstileToken` throws if
// TURNSTILE_SECRET_KEY is unset, so it can never be called by accident from
// a code path that forgot to check first. The caller (the estimator action)
// checks `env.TURNSTILE_SECRET_KEY` BEFORE rendering the form at all, so the
// real requirement -- render a "temporarily unavailable" state and never
// accept a submission or skip the gate silently -- is enforced at the route
// layer, not by this function alone.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes?: string[];
}

export async function verifyTurnstileToken(
  env: Env,
  token: string,
  remoteIp?: string,
): Promise<TurnstileVerifyResult> {
  if (!env.TURNSTILE_SECRET_KEY) {
    throw new Error("TURNSTILE_SECRET_KEY is not set");
  }
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  // THIS GATE FAILS CLOSED BY ACCIDENT, NOT BY DESIGN. Audited 2026-08-11:
  // all seven failure modes reject, but this call is the fragile one.
  //
  // There is deliberately NO try/catch and NO res.ok check here. A network
  // error, a timeout, or a non-JSON body makes fetch or res.json() throw, the
  // exception propagates out of the caller's action, and the request dies as an
  // unhandled 500. Wrong-looking, right outcome: nothing is verified and nothing
  // proceeds. A non-200 that does return JSON yields success === undefined,
  // which the caller's `if (!verification.success)` rejects.
  //
  // The hazard is that this reads like an oversight. Adding a well-meaning
  // `try { ... } catch { return { success: true } }`, or any catch that returns
  // a default-constructed result, silently INVERTS the gate from fail-closed to
  // fail-open and no test would notice. If this needs a catch, it must return
  // { success: false } and the reviewer should treat any other value as a
  // security change rather than error handling.
  const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
  const json = (await res.json()) as { success: boolean; "error-codes"?: string[] };
  return { success: json.success, errorCodes: json["error-codes"] };
}
