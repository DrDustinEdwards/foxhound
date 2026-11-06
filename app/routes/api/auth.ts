import { limitedResponse } from "@dustinedwards/site-runtime/rate-limit";

import { getAuth } from "~/lib/auth";
import { checkAuthLimit } from "~/lib/auth/rate-limit.server";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/auth";

// Better Auth HTTP surface, mounted at /api/auth/* (its default basePath). The
// single handler covers every method and sub-path (the passkey and email-link
// sign-ins, sign-out, the link's verify, the OAuth callbacks, etc.); loader
// serves GET, action serves the rest.
async function handle({ request, context }: Route.LoaderArgs | Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  return (await getAuth(env)).handler(request);
}

export function loader(args: Route.LoaderArgs) {
  return handle(args);
}

// A POST here can test a passkey or send mail (sign-in/magic-link), so it
// spends the same budget as the pages (site-runtime's limiter). Only POST
// is counted, as before: GET serves session reads and sign-in links.
export async function action(args: Route.ActionArgs) {
  if (args.request.method === "POST") {
    const { env } = args.context.get(cloudflareContext);
    const refusal = await checkAuthLimit(env, args.request, "credential");
    if (refusal) return limitedResponse(refusal);
  }
  return handle(args);
}
