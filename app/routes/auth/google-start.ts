import { redirect } from "react-router";

import { getAuth } from "~/lib/auth";
import { forwardSetCookie } from "~/lib/auth/http";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/google-start";

// Starts the Google OAuth flow (POST only). Calls Better Auth server-side to
// build the provider authorization URL and set the CSRF state cookie, then
// redirects the browser to Google carrying that cookie. Cleanly inert when the
// Google client is not configured (the button is not rendered in that case, but
// guard anyway).
export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return redirect("/login");
  }

  const res = await getAuth(env).api.signInSocial({
    body: { provider: "google", callbackURL: "/console" },
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
