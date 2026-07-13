import { cloudflareContext } from "~/lib/cloudflare-context";
import { recordClick } from "~/lib/engagement/record";
import { verifyEngagementToken } from "~/lib/engagement/token";

import type { Route } from "./+types/engagement-click";

// Engagement click redirect (ROUTES.md: /e/c/:token). A verified token records an
// idempotent click (sets the email_engaged attribution signal on the step) and
// redirects to the encoded destination. Only http(s) destinations are honored, so
// the redirect can't be abused as an open redirect to other schemes.

function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const fallback = env.BETTER_AUTH_URL || "/";
  const payload = params.token ? await verifyEngagementToken(env, params.token) : null;

  if (!payload || payload.kind !== "click" || !payload.url || !isSafeUrl(payload.url)) {
    return Response.redirect(fallback, 302);
  }
  // Best-effort: never block the customer's redirect on a tracking write.
  try {
    await recordClick(env, payload);
  } catch {
    /* swallow */
  }
  return Response.redirect(payload.url, 302);
}
