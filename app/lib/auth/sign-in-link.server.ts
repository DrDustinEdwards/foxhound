import { data } from "react-router";

import { getAuth } from "~/lib/auth";

import { safeNextPath } from "./next-path";

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

export async function requestSignInLink(
  env: Env,
  request: Request,
  link: { email: string; captchaToken: string; next: string; newUserNext: string },
): Promise<SignInLinkResult> {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of ["origin", "cf-connecting-ip", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
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
export function signInLinkAnswer(result: SignInLinkResult, email: string, limited: string) {
  switch (result) {
    case "sent":
      return data({ sent: email as string | null, error: null as string | null });
    case "limited":
      return data({ sent: null, error: limited }, { status: 429 });
    case "check_failed":
      return data({ sent: null, error: "Complete the check, then send the link again." }, { status: 400 });
    case "failed":
      return data(
        { sent: null, error: "We could not send the link. Check the address and try again." },
        { status: 500 },
      );
  }
}
