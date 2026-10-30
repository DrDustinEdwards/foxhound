// THE FOUR RENAMED COMPARISON SLUGS.
//
// Four blog posts shipped under `recova-vs-*` URLs and kept them through the
// rename. Their TITLES already said Foxhound; only the paths still carried the
// old product's name, which put it in the canonical, the sitemap and every
// inbound link. Branding divergence needs no ratification (PRIME DIRECTIVE class
// 2), so the slugs move and the old paths keep working.
//
// NOT `RECOVA_REDIRECT_MAP`, DELIBERATELY. That map exists in
// ~/lib/redirects/recova-map.ts and Fable measured it as having no runtime
// consumer at all. Wiring it here would mean either shipping a redirect table
// nobody has audited, or auditing 100+ legacy paths as a side effect of moving
// four blog posts. The four live here, where the route that serves them can see
// them, and the map's own question stays open as its own decision.
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
