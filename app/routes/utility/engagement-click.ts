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

// Built by hand rather than with Response.redirect(), which produces an
// immutable Response no header can be added to. A 302 is cacheable under
// heuristic freshness, and a cached redirect serves the destination without
// ever reaching this loader, so the click is recorded once and every later
// click on the same per-recipient URL is silently lost. That corrupts the
// email_engaged attribution signal rather than merely leaking a page, which is
// why this one mattered most of the three (Dustin, 2026-08-04). The pixel
// sibling e/o already sent these exact directives; this is the set being made
// consistent with the one route that had it right.
function noStoreRedirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
    },
  });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const fallback = env.BETTER_AUTH_URL || "/";
  const payload = params.token ? await verifyEngagementToken(env, params.token) : null;

  if (!payload || payload.kind !== "click" || !payload.url || !isSafeUrl(payload.url)) {
    return noStoreRedirect(fallback);
  }
  // Best-effort: never block the customer's redirect on a tracking write.
  try {
    await recordClick(env, payload);
  } catch {
    /* swallow */
  }
  return noStoreRedirect(payload.url);
}
