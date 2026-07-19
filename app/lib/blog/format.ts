// Pure formatting helpers for blog content. Kept dependency-free (no marked,
// no D1) so both server modules and presentational components can import
// them without pulling in server-only weight.

// Ported from legacy lib/blog-utils.ts generateSlug. Used for heading ids
// (TOC anchors); post slugs themselves come from the imported data, not
// this function.
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

// Ported from legacy lib/blog-utils.ts estimateReadingTime.
export function estimateReadingTime(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// Cluster-chip text from a kebab-case tag: "payment-recovery" -> "Payment Recovery".
// Distinct from labelForTag (tags.ts): this is a pure mechanical transform
// used where a curated label isn't warranted (e.g. a post's non-primary tags).
export function formatTagChip(tag: string): string {
  return tag
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
