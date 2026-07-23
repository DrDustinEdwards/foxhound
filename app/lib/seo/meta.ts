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
  description,
  path,
  siteUrl,
  canonical,
  image,
  imageAlt,
  ogTitle,
  ogType = "website",
}: MarketingMetaInput) {
  const resolvedCanonical = canonical ?? `${siteUrl}${path}`;
  const resolvedImage = image ?? `${siteUrl}/og/default`;
  const resolvedOgTitle = ogTitle ?? title;
  const resolvedImageAlt = imageAlt ?? "Foxhound";

  return [
    { title },
    { name: "description", content: description },
    { tagName: "link" as const, rel: "canonical", href: resolvedCanonical },
    { property: "og:type", content: ogType },
    { property: "og:title", content: resolvedOgTitle },
    { property: "og:description", content: description },
    { property: "og:url", content: resolvedCanonical },
    { property: "og:image", content: resolvedImage },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: resolvedImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: resolvedOgTitle },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: resolvedImage },
  ];
}
