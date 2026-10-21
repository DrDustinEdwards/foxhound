// The home page's "From the blog" strip (M3 divergence 34). Recova's rule, from
// app/(marketing)/page.tsx (blob c10db7d5): the featured post first, then the
// two most recent posts that are not it; with nothing featured, the three most
// recent. Pure, so the order is tested without a database.

const BLOG_STRIP_SIZE = 3;

export function blogStripCards<T extends { slug: string }>(featured: T | null, latest: T[]): T[] {
  if (!featured) return latest.slice(0, BLOG_STRIP_SIZE);
  return [featured, ...latest.filter((p) => p.slug !== featured.slug).slice(0, BLOG_STRIP_SIZE - 1)];
}
