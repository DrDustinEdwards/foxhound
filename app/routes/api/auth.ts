import { getAuth } from "~/lib/auth";
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

export function action(args: Route.ActionArgs) {
  return handle(args);
}
