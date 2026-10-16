import { protectedResourceMetadata } from "~/lib/oauth/metadata";

import type { Route } from "./+types/oauth-protected-resource";

// /.well-known/oauth-protected-resource (J79): RFC 9728 metadata for /mcp, the
// document every /mcp 401 points at, as recova-mcp served it
// (api/well-known/oauth-protected-resource.ts). Mounted at the bare path and at
// the /mcp suffix, because RFC 9728 section 3.1 has a client insert the
// resource's path after the well-known segment. no-store and any origin, as
// Recova sent it.
export function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  return Response.json(protectedResourceMetadata(origin), {
    headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}
