import { getAuth } from "~/lib/auth";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/google-callback";

// Canonical Google OAuth callback (ROUTES.md: /auth/google/callback). Google
// redirects here with ?code&state; we forward the request into the Better Auth
// handler under its internal callback path, preserving query + the CSRF state
// cookie. Better Auth validates state, exchanges the code, upserts the user +
// session, and returns a redirect carrying the session Set-Cookie.
export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const url = new URL(request.url);
  url.pathname = "/api/auth/callback/google";
  return getAuth(env).handler(new Request(url, request));
}
