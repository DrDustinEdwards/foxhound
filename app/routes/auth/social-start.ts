import { readForm } from "@dustinedwards/site-runtime/body";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { refuseCrossSite } from "@dustinedwards/site-runtime/origin";
import { signInMethods } from "@dustinedwards/site-runtime/sign-in";
import { startSocialSignIn } from "@dustinedwards/site-runtime/sign-in-form";
import { redirect } from "react-router";

import { getAuth } from "~/lib/auth";
import { nextPath, passkeyOfferURL } from "~/lib/auth/landing.server";
import { checkAuthLimit, RATE_LIMITED_ERROR } from "~/lib/auth/rate-limit.server";
import { BODY_MAX_BYTES } from "~/lib/http/body";

import type { Route } from "./+types/social-start";

// Starts a Google or Apple sign-in (POST /auth/google, /auth/apple), the sign-in
// screen's provider buttons: site-runtime's startSocialSignIn builds the
// provider's URL and Better Auth's state cookie on the server. Inert for a
// provider Foxhound has no settings for (its button is not drawn then).
export async function action({ request, context, params }: Route.ActionArgs) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  const { env } = context.get(cloudflareContext);
  // The shared auth bucket (site-runtime's limiter): a signed-out caller
  // can start sign-ins here. A form post, so a refusal goes back to the page.
  if (await checkAuthLimit(env, request, "credential")) {
    return redirect(`/login?error=${RATE_LIMITED_ERROR}`, { status: 303 });
  }
  const provider = params.provider;
  const methods = signInMethods(env, { social: true });
  if ((provider !== "google" && provider !== "apple") || !methods[provider]) {
    return redirect("/login");
  }

  // Where to land afterwards. Better Auth carries callbackURL inside its own
  // one-time OAuth state, spent on the callback, so there is no cookie to burn
  // (Recova's pending_redirect). By way of the passkey offer (A3), which goes
  // straight on to `next` for someone it does not ask.
  const form = await readForm(request, BODY_MAX_BYTES).catch(() => null);
  const start = await startSocialSignIn(await getAuth(env), request, {
    provider,
    callbackURL: passkeyOfferURL(env, nextPath(form?.get("next"))),
    // A refused sign-in (account_not_linked and the like) comes back to /login,
    // which says what happened, instead of Better Auth's own error page.
    errorCallbackURL: new URL("/login", env.BETTER_AUTH_URL).toString(),
  });
  if (!start) return redirect("/login");
  return redirect(start.location, { headers: start.headers });
}

export function loader() {
  return redirect("/login");
}
