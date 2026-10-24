import { signInMethods } from "@dustinedwards/site-runtime/sign-in";
import { redirect } from "react-router";

import { getAuth } from "~/lib/auth";
import { forwardSetCookie } from "~/lib/auth/http";
import { safeNextPath } from "~/lib/auth/next-path";
import { checkAuthLimit, RATE_LIMITED_ERROR } from "~/lib/auth/rate-limit.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/social-start";

// Starts a Google or Apple sign-in (POST /auth/google, /auth/apple). Calls
// Better Auth server-side to build the provider's authorization URL and set the
// CSRF state cookie, then redirects the browser there carrying that cookie.
// Cleanly inert for a provider Foxhound has no settings for (its button is not
// drawn then, but guard anyway).
export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  // The shared auth bucket (J52, site-runtime's limiter): a signed-out caller
  // can start sign-ins here. A form post, so a refusal goes back to the page.
  if (await checkAuthLimit(env, request, "credential")) {
    return redirect(`/login?error=${RATE_LIMITED_ERROR}`, { status: 303 });
  }
  const provider = params.provider;
  const methods = signInMethods(env, { social: true });
  if ((provider !== "google" && provider !== "apple") || !methods[provider]) {
    return redirect("/login");
  }

  // Where to land afterwards (J79; ruling 8). Recova's login set a
  // pending_redirect cookie and its callback validated it and burned it even
  // when refused. Better Auth carries callbackURL inside its own one-time OAuth
  // state, which is spent on the callback, so the validated path goes there
  // and there is no cookie to burn. It is made absolute on Foxhound's own
  // origin because Better Auth's relative-path pattern refuses a query that
  // carries an encoded URL, which an OAuth authorize URL always does.
  const form = await request.formData().catch(() => null);
  const next = safeNextPath(form ? String(form.get("next") ?? "") : null);
  const callbackURL = new URL(next, env.BETTER_AUTH_URL).toString();
  // A refused sign-in (account_not_linked and the like) comes back to /login,
  // which says what happened, instead of Better Auth's own error page.
  const errorCallbackURL = new URL("/login", env.BETTER_AUTH_URL).toString();

  const res = await (await getAuth(env)).api.signInSocial({
    body: { provider, callbackURL, errorCallbackURL },
    headers: request.headers,
    asResponse: true,
  });

  const { url } = (await res.json()) as { url?: string };
  if (!url) {
    return redirect("/login");
  }
  return redirect(url, { headers: forwardSetCookie(res) });
}

export function loader() {
  return redirect("/login");
}
