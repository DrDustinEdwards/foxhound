import { authorizationServerMetadata } from "~/lib/oauth/metadata";

import type { Route } from "./+types/oauth-metadata";

// /.well-known/oauth-authorization-server and /.well-known/openid-configuration:
// RFC 8414 discovery. Recova's next.config.ts rewrote
// both paths to one handler because Claude.ai probes both; app/routes.ts mounts
// this one module at both.
//
// The issuer is this request's own origin, as Recova derived it, so the
// document names the host the client reached. Five minutes of public caching,
// as Recova sent; it holds no per-person data. Any origin may read it, because
// a browser-based MCP client fetches it cross-origin.
export function loader({ request }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  return Response.json(authorizationServerMetadata(origin), {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
