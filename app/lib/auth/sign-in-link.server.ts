import { CONFIRM_PATH } from "@dustinedwards/site-runtime/sign-in";
import {
  safeNextPath,
  signInErrorWords,
  signInFormAction,
} from "@dustinedwards/site-runtime/sign-in-form";
import { data, redirect } from "react-router";

import { getAuth } from "~/lib/auth";

import { DEFAULT_NEXT_PATH } from "./next-path";

// The emailed sign-in link and code that /login and /signup send: site-runtime
// ./sign-in-form's signInFormAction, the one sign-in action every site runs,
// with its words. The page's action calls this after its own checkAuthLimit.
// The action goes through Better Auth's HTTP handler, not auth.api, because
// only the handler runs Better Auth's own limiter and the captcha plugin's
// Turnstile check; Better Auth's hook logs the sign-in (site-runtime ./sign-in).

const SITE = { siteName: "Foxhound", settings: "My account" } as const;

/** The words for a ?error= code that comes back to /login (the limiter's, or
 *  Better Auth's from a refused Google or Apple sign-in), or null for none. */
export function signInErrorMessage(code: string | null): string | null {
  return signInErrorWords(code, SITE);
}

/** The words for a refusal that is not the link's own (a disposable address,
 *  an account not linked, the limit), for the confirm page; null for any other
 *  code, which the confirm page words itself (site-runtime's signInLinkProblem). */
export function knownSignInError(code: string | null): string | null {
  const words = signInErrorWords(code, SITE);
  return words === signInErrorWords("unknown", SITE) ? null : words;
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

/** What /login and /signup do with their form once their limit lets it
 *  through: a typed code (the code form posts `intent=code`) signs in and goes
 *  on to the passkey offer, anything else asks for a link. A spent or expired
 *  link comes back to the confirm page, which says so. */
export async function answerSignInForm(env: Env, request: Request, form: FormData) {
  const answer = await signInFormAction(await getAuth(env), request, form, {
    landing: (next) => passkeyOfferURL(env, next),
    errorLanding: new URL(CONFIRM_PATH, env.BETTER_AUTH_URL).toString(),
    next: { fallback: DEFAULT_NEXT_PATH },
  });
  if ("location" in answer) throw redirect(answer.location, { headers: answer.headers });
  return data(answer.state, { status: answer.status });
}
