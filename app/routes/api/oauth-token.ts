import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RATE_LIMIT_OAUTH_TOKEN } from "~/lib/constants";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { exchangeToken, oauthResponse, parseOAuthBody } from "~/lib/oauth/provider.server";

import type { Route } from "./+types/oauth-token";

// POST /api/oauth/token, at Recova's path: the authorization-code and
// refresh-token grants. The work is in app/lib/oauth/provider.server.ts.
//
// RATE LIMIT: Recova's 30 a minute per IP, on 311's limiter, failing open like
// every other caller. ACTION ONLY: a GET gets 405.
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
  }
  const { env } = context.get(cloudflareContext);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await isWithinRateLimit(env, "oauth-token", ip, RATE_LIMIT_OAUTH_TOKEN.max, RATE_LIMIT_OAUTH_TOKEN.windowMs))) {
    return oauthResponse({ status: 429, body: { error: "server_error", error_description: "Too many requests" } });
  }
  const params = await parseOAuthBody(request);
  if (!params) {
    return oauthResponse({ status: 400, body: { error: "invalid_request", error_description: "Unsupported content-type" } });
  }
  return oauthResponse(await exchangeToken(getDb(env), params, new Date()));
}

export function loader() {
  return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
}
