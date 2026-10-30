import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { RATE_LIMIT_OAUTH_REGISTER } from "~/lib/constants";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { oauthResponse, registerClient } from "~/lib/oauth/provider.server";

import type { Route } from "./+types/oauth-register";

// POST /api/oauth/register, at Recova's path: RFC 7591 dynamic client
// registration. Public by specification; a registered client can do nothing
// until a signed-in merchant approves it.
//
// RATE LIMIT: Recova's 10 an hour per IP. ACTION ONLY: a GET gets 405.
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
  }
  const { env } = context.get(cloudflareContext);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await isWithinRateLimit(env, "oauth-register", ip, RATE_LIMIT_OAUTH_REGISTER.max, RATE_LIMIT_OAUTH_REGISTER.windowMs))) {
    return oauthResponse({ status: 429, body: { error: "rate_limited" } });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return oauthResponse({ status: 400, body: { error: "invalid_client_metadata" } });
  }
  return oauthResponse(await registerClient(getDb(env), body, new Date()));
}

export function loader() {
  return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
}
