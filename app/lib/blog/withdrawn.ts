// POSTS WITHDRAWN FROM THE BLOG.

/** Slugs that answered at /blog/:slug and have been deliberately withdrawn. */
export const WITHDRAWN_BLOG_SLUGS: readonly string[] = [
  "net-revenue-retention-guide",
  "subscription-intelligence-churn-prediction",
];

/**
 * True when the slug names a post that was withdrawn rather than never
 * existing.
 */
export function isWithdrawnBlogSlug(slug: string): boolean {
  return WITHDRAWN_BLOG_SLUGS.includes(slug);
}

// THE MESSAGE IS SPLIT SO ONE WORDING CAN SERVE TWO SHAPES (394 halt 4). The
// response body wants a sentence; the rendered page wants a heading and a
// paragraph under it, and repeating "This article has been withdrawn" in both
// slots reads as a stutter.

/** The withdrawal itself. No trailing period: it is also the page's heading. */
export const WITHDRAWN_BLOG_HEADING = "This article has been withdrawn";

/** Why, in one clause, so a reader does not have to guess at a motive. */
export const WITHDRAWN_BLOG_REASON =
  "It relied on third-party figures we could no longer verify against their sources, and we would rather publish nothing than publish numbers we cannot stand behind.";

/** What a reader arriving on an old link is told. Short, and it says why. */
export const WITHDRAWN_BLOG_MESSAGE = `${WITHDRAWN_BLOG_HEADING}. ${WITHDRAWN_BLOG_REASON}`;
