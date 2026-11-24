import { getBetterAuth } from "~/lib/auth";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";

import type { Route } from "./+types/google-callback";

// Google OAuth callback. Google redirects here with ?code&state; the request is forwarded into the Better Auth handler under its internal callback path, preserving the query and the CSRF state cookie. Better Auth validates state, exchanges the code, upserts the user and session, and returns a redirect carrying the session Set-Cookie.
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = new URL(request.url);
  url.pathname = "/api/auth/callback/google";
  return (await getBetterAuth(env)).handler(new Request(url, request));
}
