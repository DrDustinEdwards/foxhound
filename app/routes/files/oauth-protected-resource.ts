import { protectedResourceMetadata } from "~/lib/oauth/metadata";

import type { Route } from "./+types/oauth-protected-resource";

// /.well-known/oauth-protected-resource: RFC 9728 metadata for /mcp, the document every /mcp 401 points at. Mounted at the bare path and at the /mcp suffix, because RFC 9728 section 3.1 has a client insert the resource's path after the well-known segment. Any origin may read it. The shared Worker sends an answer with no Cache-Control as private, no-store, so the route sets no caching header of its own.
export function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  return Response.json(protectedResourceMetadata(origin), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
