import { headTags, searchTitle } from "@drdustinedwards/site-helpers/head";

// Shared meta-tag builder (TASK-foxhound-seo-remediation.md, fixing
// foxhound-audit-seo.md H1/M1/L1): every marketing route now emits the same
// tag set instead of each route hand-rolling a subset (title/description
// only, no canonical, no OG, no Twitter Card, everywhere except /blog/:slug).
//
// /og/default (app/routes/files/og.ts) is the shared fallback card image;
// callers with per-entity art (blog posts) pass `image` to override it. Width
// and height are always 1200x630 (og.ts's ImageResponse call is hardcoded to
// that size for every card type), so they are not caller-configurable here.
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
  image?: string;
  imageAlt?: string;
  /** Overrides `title` for og:title/twitter:title (blog posts use the clean
   *  headline, not the "- Foxhound Blog"-suffixed <title> string). */
  ogTitle?: string;
  ogType?: "website" | "article";
}

export function marketingMeta({
  title,
  suffix,
  description,
  path,
  siteUrl,
  canonical,
  image,
  imageAlt,
  ogTitle,
  ogType = "website",
}: MarketingMetaInput) {
  return headTags({
    origin: siteUrl,
    path,
    canonical,
    title: suffix ? searchTitle(title, suffix) : title,
    description,
    socialTitle: ogTitle ?? (suffix ? `${title}${suffix}` : undefined),
    image: { url: image ?? `${siteUrl}/og/default`, width: 1200, height: 630, alt: imageAlt ?? "Foxhound" },
    siteName: "Foxhound",
    type: ogType,
  });
}
