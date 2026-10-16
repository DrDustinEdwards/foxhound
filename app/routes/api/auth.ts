import { limitedResponse } from "@dustinedwards/site-runtime/rate-limit";

import { getAuth } from "~/lib/auth";
import { apiAuthAttempt, checkAuthLimit } from "~/lib/auth/rate-limit.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/auth";

// Better Auth HTTP surface, mounted at /api/auth/* (its default basePath). The
// single handler covers every method and sub-path (sign-in, sign-up, sign-out,
// verify-email, reset-password, the OAuth callbacks, etc.); loader serves GET,
// action serves the rest.
function handle({ request, context }: Route.LoaderArgs | Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  return getAuth(env).handler(request);
}

export function loader(args: Route.LoaderArgs) {
  return handle(args);
}

// A POST here can test a password (sign-in/email) or send mail (sign-up,
// forget-password), so it spends the same budget as the pages, and a sign-up
// spends ruling 24's hourly bucket too (J52, site-runtime's limiter). Only POST
// is counted, as before: GET serves session reads and verification links.
export async function action(args: Route.ActionArgs) {
  if (args.request.method === "POST") {
    const { env } = args.context.get(cloudflareContext);
    const refusal = await checkAuthLimit(env, args.request, apiAuthAttempt(args.request));
    if (refusal) return limitedResponse(refusal);
  }
  return handle(args);
}
