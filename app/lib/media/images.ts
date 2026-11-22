import { defineImages, imageVersion } from "@dustinedwards/site-runtime/image";

// The blog's pictures through site-runtime ./image: the post attributes (markdown.server.ts) and the serving route
// (app/routes/files/media.ts) share one closed set of widths, so a linked width is never a 400 and an unlinked width is
// never a billed transform.

/** The post column is 680 CSS px wide; the featured post fills half the 1280 px band, or the page under 1024 px. */
export const images = defineImages({
  uses: {
    content: { layout: "constrained", width: 680 },
    featured: {
      layout: "constrained",
      width: 976,
      sizes: "(min-width: 1280px) 592px, (min-width: 1024px) calc(50vw - 48px), calc(100vw - 48px)",
    },
  },
  // The share crop and the Article image set (16:9, 4:3 and 1:1 at 1200 wide) for a post's structured data.
  shareImages: true,
});

const MEDIA_PATH = "/media/";

/** The keys an upload is stored under: `<year>/<month>/<name>-<8 hex>.<ext>`. The route serves only these, so nothing
 *  else in the bucket (the earlier bytes under revisions/) is ever public. */
export const UPLOAD_KEY = /^\d{4}\/\d{2}\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:jpg|png|webp|avif|gif)$/;

export const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

/** A file's address. With the SHA-256 it names these bytes (`?v=`), served for a year, immutable: a replace, turn or revert is a new address. */
export const mediaUrl = (key: string, sha256?: string) =>
  `${MEDIA_PATH}${key}${sha256 ? `?v=${imageVersion(sha256)}` : ""}`;

/** Where a post names a library file: `/media/<key>` or this site's full URL to it (site-runtime ./image's keyOfAddress). */
export const MEDIA_ADDRESSES = {
  origins: ["https://foxhoundapp.com", "https://www.foxhoundapp.com"],
};
