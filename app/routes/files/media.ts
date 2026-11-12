import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { imageVersion } from "@dustinedwards/site-runtime/image";
import { images, UPLOAD_KEY } from "~/lib/media/images";
import { mediaRow } from "~/lib/media/store.server";

import type { Route } from "./+types/media";

// The blog's media library files (app/lib/carrel/media-adapter.server.ts): the
// original, or one size for `?w=`, through site-runtime ./image's serve,
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

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  // `caches.default` is the Workers runtime's; the DOM lib does not declare it.
  const cache = (caches as typeof caches & { default: Cache }).default;
  return images.serve(request, {
    // Only an upload's own key is read; anything else is a miss, so revisions/ never is served.
    read: (key) => (UPLOAD_KEY.test(key) ? env.MEDIA.get(key) : Promise.resolve(null)),
    images: env.IMAGES,
    cache,
    cacheControl: async ({ url, key }) => {
      const version = url.searchParams.get("v");
      const current = version
        ? imageVersion((await mediaRow(getDb(env), key))?.sha256) === version
        : false;
      return current ? undefined : UNVERSIONED_CACHE_CONTROL;
    },
  });
}
