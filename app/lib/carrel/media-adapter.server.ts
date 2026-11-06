import { slugify } from "@drdustinedwards/site-helpers/slug";
import {
  RefusedError,
  mediaLibrary,
  type MediaAdapter,
  type MediaKeyInput,
  type MediaResize,
} from "@dustinedwards/site-api";

import type { Db } from "~/db";
import { EXTENSIONS, UPLOAD_KEY, mediaUrl } from "~/lib/media/images";
import { mediaStore } from "~/lib/media/store.server";
import { suggestFor } from "~/lib/media/suggest.server";
import { mediaUses } from "~/lib/media/usage.server";

// Carrel's media group over the blog's media library: site-api's mediaLibrary
// over the R2 bucket MEDIA and the index tables of migration 0059
// (mediaStore). Carrel is the only writer; nothing here touches a merchant
// table, Stripe, or a money path. What is the blog's own is set here: the
// pictures it takes, its addresses and keys, the shrink size, the reference
// check, where earlier bytes are kept, and the suggester. Not
// `replaceKeepsSize`: a post's picture is sized from the index row each time
// the post renders (markdown.server.ts), not from its address, so new bytes of
// another size are honest here.

/** The pictures a post can show. No SVG (it can carry script) and nothing that is not a picture. */
const LIMITS = { maxBytes: 20 * 1024 * 1024, types: Object.keys(EXTENSIONS) };

/** What an upload shrinks to unless it says `resize=no`: wide enough for any screen the 680 px column is shown on at 3x. */
const RESIZE: MediaResize = { maxEdge: 2560, quality: 85 };

/** How much of the upload's hash a key carries, a few more characters on each clash. */
const HASH_LENGTHS = [8, 12, 16, 64];

/**
 * `<year>/<month>/<name>-<hash>.<ext>`, the only keys the media route serves (UPLOAD_KEY), so nothing else in the
 * bucket (the earlier bytes kept under revisions/) is ever public.
 */
function uploadKey(file: MediaKeyInput, attempt: number): string {
  const length = HASH_LENGTHS[attempt - 1];
  if (!length)
    throw new RefusedError(
      "A file with these bytes is already stored under every address this upload could take.",
    );
  const name = slugify(file.filename.replace(/\.[^.]*$/, ""), { max: 60 }) || "picture";
  const key = `${file.at.slice(0, 4)}/${file.at.slice(5, 7)}/${name}-${file.sha256.slice(0, length)}.${EXTENSIONS[file.contentType]}`;
  if (!UPLOAD_KEY.test(key))
    throw new RefusedError(`${file.filename} cannot be stored under a library address.`);
  return key;
}

export function carrelMediaAdapter(env: Env, db: Db): MediaAdapter {
  return mediaLibrary({
    store: mediaStore(db),
    bucket: env.MEDIA,
    images: env.IMAGES,
    limits: LIMITS,
    url: (key) => mediaUrl(key),
    key: uploadKey,
    resize: RESIZE,
    // One read of the posts answers every key (usage.server.ts).
    usage: () => mediaUses(db),
    // In the served bucket, where they always were: the media route serves only UPLOAD_KEY (app/routes/files/media.ts).
    history: { prefix: "revisions/" },
    suggest: (picture, id) => suggestFor(env, picture, id),
    // The package checks every address and each redirect before this fetch runs (importRefusal, fetchImport).
    importFetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, init)) as typeof fetch,
  });
}
