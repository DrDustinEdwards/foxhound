// THE FOUR RENAMED COMPARISON SLUGS (376 item 21).
//
// Four blog posts shipped under `recova-vs-*` URLs and kept them through the
// rename. Their TITLES already said Foxhound; only the paths still carried the
// old product's name, which put it in the canonical, the sitemap and every
// inbound link. Branding divergence needs no ratification (PRIME DIRECTIVE class
// 2), so the slugs move and the old paths keep working.
//
// The Recova cutover map (~/lib/redirects/recova-map.ts) reads this table too,
// so recovamrr.com/blog/recova-vs-* goes straight to the new slug in one hop
// instead of landing here and redirecting again.
//
// PERMANENT, not temporary: these URLs are indexed and linked, and 301 is what
// tells a crawler to move its equity to the new path. A 302 would leave the old
// URL as the canonical one forever.

/** Old slug to new slug, for the four comparison posts renamed at 376 item 21. */
export const BLOG_SLUG_REDIRECTS: Readonly<Record<string, string>> = {
  "recova-vs-churn-buster": "foxhound-vs-churn-buster",
  "recova-vs-churnkey": "foxhound-vs-churnkey",
  "recova-vs-paddle-retain": "foxhound-vs-paddle-retain",
  "recova-vs-stripe-smart-retries": "foxhound-vs-stripe-smart-retries",
};

/** The new slug for an old one, or null when the slug was never renamed. */
export function redirectedBlogSlug(slug: string): string | null {
  return BLOG_SLUG_REDIRECTS[slug] ?? null;
}
