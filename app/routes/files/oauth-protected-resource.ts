import { protectedResourceMetadata } from "~/lib/oauth/metadata";

import type { Route } from "./+types/oauth-protected-resource";

// /.well-known/oauth-protected-resource (J79): RFC 9728 metadata for /mcp, the
// document every /mcp 401 points at, as recova-mcp served it
// (api/well-known/oauth-protected-resource.ts). Mounted at the bare path and at
// the /mcp suffix, because RFC 9728 section 3.1 has a client insert the
// resource's path after the well-known segment. Any origin may read it, as
// Recova sent it. Recova also sent no-store; here the shared cache policy gives
// this unlisted path private, no-store (app/lib/http/cache-policy.ts), so the
// route sets no caching header of its own (test/cache-policy.test.ts, PLANT 7).
export function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  return Response.json(protectedResourceMetadata(origin), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
