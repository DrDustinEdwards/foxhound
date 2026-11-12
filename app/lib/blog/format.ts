// Pure formatting helpers for blog content. Kept dependency-free (no marked,
// no D1) so both server modules and presentational components can import
// them without pulling in server-only weight.

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
