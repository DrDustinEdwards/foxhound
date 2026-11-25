import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { clientIp } from "@dustinedwards/site-runtime/http";
import { registrationRefusal } from "@dustinedwards/site-runtime/mcp-login";
import {
  RATE_LIMIT_OAUTH_REGISTER,
  RATE_LIMIT_OAUTH_REGISTER_DAILY,
} from "~/lib/http/rate-limit-buckets";
import { isWithinRateLimit } from "~/lib/http/rate-limit";
import { oauthResponse, registerClient, registrationCallbacks } from "~/lib/oauth/provider.server";

import type { Route } from "./+types/oauth-register";
import { readJson } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// POST /api/oauth/register: RFC 7591 dynamic client registration. The MCP authorization spec makes it a MAY beside client ID metadata documents, which Claude, Claude Code and ChatGPT use; it stays for Grok and Gemini, and only for the exact callbacks on the shared allowlist (registerClient). A registered client can do nothing until a signed-in merchant approves it.
// RATE LIMIT: site-runtime's registrationLimited numbers (constants.ts), counted on the RateLimiter Durable Object rather than in KV, and failing closed: a limiter that cannot answer refuses. ACTION ONLY: a GET gets 405.
export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  if (request.method !== "POST") {
    return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
  }
  const within = (bucket: string, key: string, rule: { max: number; windowMs: number }) =>
    isWithinRateLimit(env, bucket, key, rule.max, rule.windowMs, { failClosed: true }).catch(
      () => false,
    );
  const limited = () =>
    oauthResponse({ status: 429, body: { error: "rate_limited" } }, { "Retry-After": "3600" });
  if (!(await within("oauth-register", clientIp(request), RATE_LIMIT_OAUTH_REGISTER))) {
    return limited();
  }
  let body: unknown;
  try {
    body = await readJson(request, BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof Response) throw error;
    return oauthResponse({ status: 400, body: { error: "invalid_client_metadata" } });
  }
  const allowed = registrationCallbacks(env);
  if (
    body !== null &&
    typeof body === "object" &&
    registrationRefusal(allowed, body as Record<string, unknown>) === null &&
    !(await within("oauth-register-all", "all", RATE_LIMIT_OAUTH_REGISTER_DAILY))
  ) {
    return limited();
  }
  return oauthResponse(await registerClient(getDb(env), body, new Date(), allowed));
}

export function loader() {
  return oauthResponse({ status: 405, body: { error: "invalid_request" } }, { Allow: "POST" });
}
