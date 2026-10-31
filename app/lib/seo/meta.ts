import { headTags, searchTitle, type HeadImage } from "@drdustinedwards/site-helpers/head";
import type { MiddlewareFunction } from "react-router";

// Shared meta-tag builder (TASK-foxhound-seo-remediation.md, fixing
// foxhound-audit-seo.md H1/M1/L1): every marketing route now emits the same
// tag set instead of each route hand-rolling a subset (title/description
// only, no canonical, no OG, no Twitter Card, everywhere except /blog/:slug).
//
// /og/default (app/routes/files/og.ts) is the shared fallback card image, a
// real 1200x630; callers with per-entity art (blog posts) pass `image` with
// that picture's own size, or none where it is not known.
/** For pages a search engine has no business indexing: the sign-in pages, the
 *  signed-in app and the admin. Their layouts also send `X-Robots-Tag`. */
export const NOINDEX = { name: "robots", content: "noindex" } as const;

/** The header form of NOINDEX, for a layout's middleware: it covers every
 *  response under the layout, the ones with no `<head>` as well. */
export const noindexHeader: MiddlewareFunction<Response> = async (_args, next) => {
  const response = await next();
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
};

export interface MarketingMetaInput {
  title: string;
  /** The site's suffix, such as " - Foxhound Blog". A title too long for a
   *  search result drops it and is cut at a word (Prelum's searchTitle); the
   *  share card keeps the whole title. */
  suffix?: string;
  description: string;
  path: string;
  siteUrl: string;
  /** Overrides the default `${siteUrl}${path}` (blog posts have their own
   *  canonicalUrl column). */
  canonical?: string;
  /** Overrides the default `${siteUrl}/og/default` (blog posts have their
   *  own cover image or generated per-post card). */
  image?: HeadImage;
  /** Overrides `title` for og:title/twitter:title (blog posts use the clean
   *  headline, not the "- Foxhound Blog"-suffixed <title> string). */
  ogTitle?: string;
  ogType?: "website" | "article";
  /** robots noindex (a blog post's search field). */
  noindex?: boolean;
}

export function marketingMeta({
  title,
  suffix,
  description,
  path,
  siteUrl,
  canonical,
  image,
  ogTitle,
  ogType = "website",
  noindex,
}: MarketingMetaInput) {
  return headTags({
    origin: siteUrl,
    path,
    canonical,
    title: suffix ? searchTitle(title, suffix) : title,
    description,
    socialTitle: ogTitle ?? (suffix ? `${title}${suffix}` : undefined),
    image: image ?? { url: `${siteUrl}/og/default`, width: 1200, height: 630, type: "image/png", alt: "Foxhound" },
    siteName: "Foxhound",
    type: ogType,
    noindex,
  });
}
