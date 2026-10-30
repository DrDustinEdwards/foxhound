import { defineImages } from "@dustinedwards/site-runtime/image";

// The blog's pictures, end to end through site-runtime ./image: the attributes a
// post writes (markdown.server.ts) and the route that serves each size
// (app/routes/files/media.ts) share this one closed set, so a width a page links
// is never a 400, and a width no page links is never a billed transform.

/** The post column is 680 CSS px wide (app/routes/blog/post.tsx). */
export const images = defineImages({
  uses: {
    content: { layout: "constrained", width: 680 },
  },
});

/** Where the library's files are served. */
const MEDIA_PATH = "/media/";

/**
 * The keys an upload is stored under: `<year>/<month>/<name>-<8 hex>.<ext>`.
 * The route serves only these, so nothing else in the bucket (the earlier bytes
 * kept under revisions/) is ever public.
 */
export const UPLOAD_KEY = /^\d{4}\/\d{2}\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:jpg|png|webp|avif|gif)$/;

/** The extension each accepted type is stored under. */
export const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

export const mediaUrl = (key: string) => `${MEDIA_PATH}${key}`;

/**
 * The library key a post's image address cites, or null when it is not one:
 * `/media/<key>` or this site's full URL to it, with any `?w=` size dropped.
 */
export function mediaKeyOf(src: string): string | null {
  const path = src.replace(/^https:\/\/(?:www\.)?foxhoundapp\.com(?=\/)/, "").split(/[?#]/)[0] ?? "";
  if (!path.startsWith(MEDIA_PATH)) return null;
  const key = path.slice(MEDIA_PATH.length);
  return UPLOAD_KEY.test(key) ? key : null;
}

/** Every library key a markdown source cites, once each, in order. */
export function mediaKeysIn(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/(?:https:\/\/(?:www\.)?foxhoundapp\.com)?\/media\/[^\s)"'<>\]]+/g)) {
    const key = mediaKeyOf(m[0]);
    if (key) keys.add(key);
  }
  return [...keys];
}
