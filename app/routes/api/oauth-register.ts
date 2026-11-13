import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { RATE_LIMIT_OAUTH_REGISTER } from "~/lib/constants";
import { isIpWithinRateLimit } from "~/lib/http/rate-limit";
import { oauthResponse, registerClient, registrationCallbacks } from "~/lib/oauth/provider.server";

import type { Route } from "./+types/oauth-register";
import { readJson } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// POST /api/oauth/register, at Recova's path: RFC 7591 dynamic client
// registration, kept for the clients that still need it, each redirect URI on
// the shared allowlist (registerClient). A registered client can do nothing
// until a signed-in merchant approves it.
//
// RATE LIMIT: Recova's 10 an hour per IP. ACTION ONLY: a GET gets 405.
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
  }
  const { env } = context.get(cloudflareContext);
  if (!(await isIpWithinRateLimit(env, request, "oauth-register", RATE_LIMIT_OAUTH_REGISTER))) {
    return oauthResponse({ status: 429, body: { error: "rate_limited" } });
  }
  let body: unknown;
  try {
    body = await readJson(request, BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof Response) throw error;
    return oauthResponse({ status: 400, body: { error: "invalid_client_metadata" } });
  }
  return oauthResponse(
    await registerClient(getDb(env), body, new Date(), registrationCallbacks(env)),
  );
}

export function loader() {
  return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
}
