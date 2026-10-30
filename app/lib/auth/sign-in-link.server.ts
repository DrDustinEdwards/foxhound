import { SIGN_IN_CODE_PATH } from "@dustinedwards/site-runtime/sign-in";
import { data, redirect } from "react-router";

import { getAuth } from "~/lib/auth";

import { safeNextPath } from "./next-path";
import { checkEmailLimit, SIGN_IN_LIMITED, SIGN_UP_LIMITED } from "./rate-limit.server";

// The emailed sign-in link that /login and /signup send (site-runtime
// ./sign-in's magic link). The page's action calls this after its own
// checkAuthLimit. It goes through Better Auth's HTTP handler, not auth.api,
// because only the handler runs Better Auth's own limiter and the captcha
// plugin's Turnstile check (txasm signin.tsx, Grok audit TX-4).

export type SignInLinkResult = "sent" | "limited" | "check_failed" | "failed";

/** Where the link lands: the passkey offer, which goes on to `next` (straight
 *  away for someone who already has a passkey). Absolute on Foxhound's own
 *  origin, as /auth/google makes its callback, because Better Auth's
 *  relative-path check refuses a query that carries an encoded URL, which an
 *  OAuth authorize `next` always does (J79). */
function afterLinkURL(env: Env, next: string): string {
  return new URL(`/passkey?next=${encodeURIComponent(safeNextPath(next))}`, env.BETTER_AUTH_URL).toString();
}

/** The headers Better Auth's handler is handed for a signed-out POST: the
 *  origin it checks, the address its limiter counts and the user agent. */
function forwardedHeaders(request: Request): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of ["origin", "cf-connecting-ip", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function requestSignInLink(
  env: Env,
  request: Request,
  link: { email: string; captchaToken: string; next: string; newUserNext: string },
): Promise<SignInLinkResult> {
  const headers = forwardedHeaders(request);
  if (link.captchaToken) headers.set("x-captcha-response", link.captchaToken);

  try {
    const res = await (await getAuth(env)).handler(
      new Request(new URL("/api/auth/sign-in/magic-link", env.BETTER_AUTH_URL), {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: link.email,
          callbackURL: afterLinkURL(env, link.next),
          newUserCallbackURL: afterLinkURL(env, link.newUserNext),
          // A spent or expired link comes back to /login, which says so.
          errorCallbackURL: new URL("/login", env.BETTER_AUTH_URL).toString(),
        }),
      }),
    );
    if (res.status === 429) return "limited";
    if (res.status === 400 || res.status === 403) {
      const { code } = (await res.clone().json().catch(() => ({}))) as { code?: string };
      if (code === "MISSING_RESPONSE" || code === "VERIFICATION_FAILED") return "check_failed";
    }
    if (!res.ok) {
      // The status only: the body can carry the address.
      console.error(`[sign-in-link] request returned ${res.status}`);
      return "failed";
    }
    return "sent";
  } catch {
    // sendMagicLink's throw names the send's reason, never the link; it is not
    // repeated here because the address is in the request.
    console.error("[sign-in-link] the link was not sent");
    return "failed";
  }
}

/** The page's answer to a link request, for /login and /signup: the address
 *  the link went to, or the words its alert shows. */
function signInLinkAnswer(result: SignInLinkResult, email: string, limited: string) {
  switch (result) {
    case "sent":
      return data({ sent: email as string | null, error: null as string | null, codeError: null as string | null });
    case "limited":
      return data({ sent: null, error: limited, codeError: null }, { status: 429 });
    case "check_failed":
      return data(
        { sent: null, error: "Complete the check, then send the link again.", codeError: null },
        { status: 400 },
      );
    case "failed":
      return data(
        { sent: null, error: "We could not send the link. Check the address and try again.", codeError: null },
        { status: 500 },
      );
  }
}

// ---- the code in the same mail ---------------------------------------------------
//
// The link signs in the browser that opens it, which is the mail app's, often
// not the tab that asked (a private window, a phone): Dustin's live signup on
// 2026-10-29 never signed in the incognito tab. The mail also carries a six-digit
// code (site-runtime ./sign-in), typed on the page that said the link was sent,
// so the tab that asked signs in. A wrong code counts; after three it is spent,
// and the link still works. Through the handler again, for Better Auth's limiter.

export type SignInCodeResult =
  | { status: "signed_in"; headers: Headers }
  | { status: "wrong" | "spent" | "disposable" | "limited" | "failed" };

export async function signInWithCode(
  env: Env,
  request: Request,
  attempt: { email: string; code: string },
): Promise<SignInCodeResult> {
  try {
    const res = await (await getAuth(env)).handler(
      new Request(new URL(`/api/auth${SIGN_IN_CODE_PATH}`, env.BETTER_AUTH_URL), {
        method: "POST",
        headers: forwardedHeaders(request),
        body: JSON.stringify({ email: attempt.email, otp: attempt.code }),
      }),
    );
    if (res.ok) {
      // Only the session cookies go on to the page's redirect.
      const headers = new Headers();
      for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
      return { status: "signed_in", headers };
    }
    if (res.status === 429) return { status: "limited" };
    const { code } = (await res.json().catch(() => ({}))) as { code?: string };
    if (code === "INVALID_OTP") return { status: "wrong" };
    if (code === "OTP_EXPIRED" || code === "TOO_MANY_ATTEMPTS") return { status: "spent" };
    if (code === "disposable_email") return { status: "disposable" };
    // The status only: the body can carry the address.
    console.error(`[sign-in-code] sign-in returned ${res.status}`);
    return { status: "failed" };
  } catch {
    console.error("[sign-in-code] the sign-in did not complete");
    return { status: "failed" };
  }
}

const CODE_ANSWERS = {
  wrong: "That code is not right. Check the email and try again.",
  spent: "That code has expired or was tried too many times. Use the link in the email, or send a new one.",
  disposable: "Please use a real email address. Disposable email providers are not allowed.",
  failed: "That sign-in did not complete. Try again or use the link in the email.",
} as const;

/** The page's answer to a typed code: on to the passkey offer and `next`, as
 *  the link goes, or the "link sent" screen again with the words its alert
 *  shows. `limited` is the page's own words for its limit. */
function signInCodeAnswer(env: Env, result: SignInCodeResult, email: string, next: string, limited: string) {
  if (result.status === "signed_in") throw redirect(afterLinkURL(env, next), { headers: result.headers });
  const error = result.status === "limited" ? limited : CODE_ANSWERS[result.status];
  const status = result.status === "limited" ? 429 : result.status === "failed" ? 500 : 400;
  return data({ sent: email as string | null, error: null as string | null, codeError: error }, { status });
}

/** What /login and /signup do with their form once their limit lets it
 *  through: a typed code (the form posted with `?code`) signs in, anything
 *  else asks for a link. `limited` is the page's own words for its limit. */
export async function answerSignInForm(
  env: Env,
  request: Request,
  form: FormData,
  page: { isCode: boolean; limited: string },
) {
  const email = String(form.get("email") ?? "").trim();
  if (!email) return data({ sent: null, error: "Enter your email address.", codeError: null }, { status: 400 });
  const next = safeNextPath(String(form.get("next") ?? ""));

  // The address's own budget, after the page's IP limit (rate-limit.server.ts).
  // Its window is an hour or a day, so the words say "later", not "a minute".
  const emailRefusal = await checkEmailLimit(env, email, page.isCode ? "code" : "link");
  if (emailRefusal) {
    return data(
      page.isCode
        ? { sent: email as string | null, error: null as string | null, codeError: SIGN_UP_LIMITED as string | null }
        : { sent: null, error: SIGN_UP_LIMITED, codeError: null },
      { status: 429, headers: { "Retry-After": String(emailRefusal.retryAfterSeconds) } },
    );
  }

  // The code from the same mail, typed on the "link sent" screen.
  if (page.isCode) {
    const code = String(form.get("code") ?? "").trim();
    return signInCodeAnswer(env, await signInWithCode(env, request, { email, code }), email, next, SIGN_IN_LIMITED);
  }

  const result = await requestSignInLink(env, request, {
    email,
    captchaToken: String(form.get("cf-turnstile-response") ?? ""),
    next,
    // Someone new lands where a Google signup does.
    newUserNext: next,
  });
  return signInLinkAnswer(result, email, page.limited);
}
