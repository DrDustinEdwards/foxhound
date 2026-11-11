import { logEvent, OWASP_EVENTS, requestFields } from "@dustinedwards/site-runtime/log";
import { CONFIRM_PATH } from "@dustinedwards/site-runtime/sign-in";
import {
  requestSignInLink,
  safeNextPath,
  signInWithCode,
} from "@dustinedwards/site-runtime/sign-in-form";
import { data, redirect } from "react-router";

import { getAuth } from "~/lib/auth";

import { DEFAULT_NEXT_PATH } from "./next-path";
import { RATE_LIMITED_ERROR, SIGN_IN_LIMITED, SIGN_UP_LIMITED } from "./rate-limit.server";

// The emailed sign-in link that /login and /signup send (site-runtime
// ./sign-in's magic link). The page's action calls this after its own
// checkAuthLimit. It goes through Better Auth's HTTP handler, not auth.api,
// because only the handler runs Better Auth's own limiter and the captcha
// plugin's Turnstile check (txasm signin.tsx, Grok audit TX-4).

/** The ?error= codes that come back to /login: the limiter's, and Better
 *  Auth's from a refused Google or Apple sign-in. Null for none. A spent or
 *  expired link lands on its confirm page instead, which tells used, expired
 *  and cut short apart (site-runtime's signInLinkProblem). */
const ERROR_MESSAGES: Record<string, string> = {
  [RATE_LIMITED_ERROR]: SIGN_IN_LIMITED,
  // The disposable-address refusal (app/lib/auth/options.ts), in Recova's words
  // (app/(auth)/login/page.tsx).
  disposable_email: "Please use a real email address. Disposable email providers are not allowed.",
  // Accounts are joined only by a signed-in person (site-runtime ./sign-in),
  // never by a matching email at sign-in, so this one has a way forward.
  account_not_linked:
    "That email already has a Foxhound account. Sign in with an email link, then connect Google or Apple in My account.",
};

/** Foxhound's own words for a code it knows, or null: the confirm page uses
 *  them for a refusal that is not the link's (a disposable address). */
export function knownSignInError(code: string | null): string | null {
  return code ? (ERROR_MESSAGES[code] ?? null) : null;
}

export function signInErrorMessage(code: string | null): string | null {
  return code
    ? (ERROR_MESSAGES[code] ?? "That sign-in did not complete. Try again or use another way.")
    : null;
}

/** Where a sign-in by link, code, Google or Apple lands: the passkey offer,
 *  which goes on to `next` (straight away when site-runtime's
 *  shouldOfferPasskey says no). Absolute on Foxhound's own
 *  origin, as /auth/google makes its callback, because Better Auth's
 *  relative-path check refuses a query that carries an encoded URL, which an
 *  OAuth authorize `next` always does. */
export function passkeyOfferURL(env: Env, next: string): string {
  return new URL(
    `/passkey?next=${encodeURIComponent(safeNextPath(next, { fallback: DEFAULT_NEXT_PATH }))}`,
    env.BETTER_AUTH_URL,
  ).toString();
}

/** The page's answer to a link request, for /login and /signup: the address
 *  the link went to, or the words its alert shows. */
function signInLinkAnswer(result: LinkResult, email: string, limited: string) {
  switch (result) {
    case "sent":
      return data({
        sent: email as string | null,
        error: null as string | null,
        codeError: null as string | null,
      });
    case "limited":
    case "email-limited":
      return data(
        { sent: null, error: result === "limited" ? limited : SIGN_UP_LIMITED, codeError: null },
        { status: 429 },
      );
    case "check-failed":
      return data(
        { sent: null, error: "Complete the check, then send the link again.", codeError: null },
        { status: 400 },
      );
    case "unavailable":
      return data(
        {
          sent: null,
          error:
            "Sign-in links are switched off for a moment. Sign in with a passkey, or try again later.",
          codeError: null,
        },
        { status: 503 },
      );
    case "failed":
      return data(
        {
          sent: null,
          error: "We could not send the link. Check the address and try again.",
          codeError: null,
        },
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

type LinkResult = Awaited<ReturnType<typeof requestSignInLink>>;
type CodeResult = Awaited<ReturnType<typeof signInWithCode>>;

const CODE_ANSWERS = {
  wrong: "That code is not right. Check the email and try again.",
  spent:
    "That code has expired or was tried too many times. Use the link in the email, or send a new one.",
  expired:
    "That code has expired or was tried too many times. Use the link in the email, or send a new one.",
  disposable: "Please use a real email address. Disposable email providers are not allowed.",
  unavailable: "Codes cannot be checked right now. Use the link in the email instead.",
  failed: "That sign-in did not complete. Try again or use the link in the email.",
} as const;

/** The page's answer to a typed code: on to the passkey offer and `next`, as
 *  the link goes, or the "link sent" screen again with the words its alert
 *  shows. `limited` is the page's own words for its limit. */
function signInCodeAnswer(
  env: Env,
  result: CodeResult,
  email: string,
  next: string,
  limited: string,
) {
  if (result.status === "signed-in")
    throw redirect(passkeyOfferURL(env, next), { headers: result.headers });
  const error =
    result.status === "limited"
      ? limited
      : result.status === "email-limited"
        ? SIGN_UP_LIMITED
        : CODE_ANSWERS[result.status];
  const status = result.status.endsWith("limited")
    ? 429
    : result.status === "unavailable"
      ? 503
      : result.status === "failed"
        ? 500
        : 400;
  return data(
    { sent: email as string | null, error: null as string | null, codeError: error },
    { status },
  );
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
  if (!email)
    return data(
      { sent: null, error: "Enter your email address.", codeError: null },
      { status: 400 },
    );
  const next = safeNextPath(String(form.get("next") ?? ""), { fallback: DEFAULT_NEXT_PATH });
  const auth = await getAuth(env);

  // The code from the same mail, typed on the "link sent" screen.
  if (page.isCode) {
    const code = String(form.get("code") ?? "").trim();
    const result = await signInWithCode(auth, request, { email, code });
    if (result.status === "signed-in")
      logEvent(OWASP_EVENTS.signInSuccess, { ...requestFields(request), via: "code" });
    return signInCodeAnswer(env, result, email, next, SIGN_IN_LIMITED);
  }

  const result = await requestSignInLink(auth, request, {
    email,
    captchaToken: String(form.get("cf-turnstile-response") ?? ""),
    callbackURL: passkeyOfferURL(env, next),
    // Someone new lands where a Google signup does.
    newUserCallbackURL: passkeyOfferURL(env, next),
    // A spent or expired link comes back to the confirm page, which says so.
    errorCallbackURL: new URL(CONFIRM_PATH, env.BETTER_AUTH_URL).toString(),
  });
  return signInLinkAnswer(result, email, page.limited);
}
