import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RATE_LIMIT_OAUTH_REVOKE } from "~/lib/constants";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { oauthResponse, parseOAuthBody, revokeOAuthToken } from "~/lib/oauth/provider.server";

import type { Route } from "./+types/oauth-revoke";

// POST /api/oauth/revoke, at Recova's path: RFC 7009 revocation. Always
// 200 with an empty body, as Recova answered, so the endpoint never says
// whether a token was real. RATE LIMIT: Recova's 30 a minute per IP. The
// shared cache policy makes every response here private, no-store, so the
// route sets no caching header of its own (test/cache-policy.test.ts, PLANT 7).
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
  }
  const { env } = context.get(cloudflareContext);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await isWithinRateLimit(env, "oauth-revoke", ip, RATE_LIMIT_OAUTH_REVOKE.max, RATE_LIMIT_OAUTH_REVOKE.windowMs))) {
    return new Response(null, { status: 429 });
  }
  const params = await parseOAuthBody(request);
  await revokeOAuthToken(getDb(env), params?.get("token") ?? null, new Date());
  return new Response(null, { status: 200 });
}

export function loader() {
  return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
}
