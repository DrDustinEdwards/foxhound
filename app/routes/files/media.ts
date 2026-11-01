import { originalKey } from "@dustinedwards/site-runtime/image";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { images, UPLOAD_KEY, VERSION_LENGTH } from "~/lib/media/images";
import { mediaRow } from "~/lib/media/store.server";

import type { Route } from "./+types/media";

// The blog's media library files (app/lib/carrel/media-adapter.server.ts): the
// original, or one size for `?w=`, through site-runtime ./image's one route,
// with its closed width set, ETag and 304, the edge cache keyed by the
// object's etag, and the original when a transform fails. Only an upload's own
// key is served, so the earlier bytes kept under revisions/ never are. No SVG
// is ever stored, so no picture here can carry script.
//
// IMMUTABLE ONLY WHEN VERSIONED. A page names a file by its bytes (`?v=`, the
// start of the index row's SHA-256, mediaUrl), so a replace, a turn or a revert
// is a new address and the year-long immutable default of ./image's respond is
// safe. An address without a version, or with one that is no longer the file's,
// would outlive new bytes under the same key, so it gets five minutes, as the
// blog's own short TTL does (cache-policy.ts); the transformed sizes stay in the
// Cache API by etag, so a refresh is not another billed transform.
const UNVERSIONED_CACHE_CONTROL = "public, max-age=300";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  // A size URL is suffixed (photo.jpg.webp?w=640); the stored key is the original's.
  const key = originalKey(params["*"] ?? "", request);
  if (!UPLOAD_KEY.test(key)) return new Response("Not found", { status: 404 });
  const { env } = context.get(cloudflareContext);
  const version = new URL(request.url).searchParams.get("v");
  const current = version ? (await mediaRow(getDb(env), key))?.sha256.slice(0, VERSION_LENGTH) === version : false;
  const read = () => env.MEDIA.get(key);
  // `caches.default` is the Workers runtime's; the DOM lib does not declare it.
  const cache = (caches as typeof caches & { default: Cache }).default;
  return images.respond(request, { object: await read(), images: env.IMAGES, cache, cacheControl: current ? undefined : UNVERSIONED_CACHE_CONTROL, reread: read });
}
