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

  const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
  const json = (await res.json()) as { success: boolean; "error-codes"?: string[] };
  return { success: json.success, errorCodes: json["error-codes"] };
}
