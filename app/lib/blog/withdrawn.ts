// POSTS WITHDRAWN FROM THE BLOG (391, Dustin's decision).
//
// Two posts were built almost entirely on third-party benchmarks whose sources
// could not be verified against any fixed document, live or archived:
// `net-revenue-retention-guide` (26 of its 27 numeric sentences) and
// `subscription-intelligence-churn-prediction` (18 of 19). Repairing them would
// have left an article with its evidence removed and its argument gone, so they
// come down instead.
//
// THE ROW IS UNPUBLISHED, NOT DELETED. `published = 0` takes them out of the
// index, the sitemap and the RSS feed by construction, because every one of
// those readers filters on `published`. The body stays in the store so the work
// can be rewritten from sources that hold, rather than retyped.
//
// 410 GONE, NOT 301 TO THE INDEX, and the choice is deliberate:
//
//   A 301 asserts that the content MOVED and that the destination is its
//   replacement. Neither is true here. The blog index is not a substitute for a
//   guide on net revenue retention, so a search engine following the redirect
//   finds a page that does not answer the query and treats it as a soft 404
//   anyway, which is the worst of both: the wrong signal AND the delay.
//
//   410 says what actually happened. The page is gone on purpose and is not
//   coming back at this URL. Crawlers drop a 410 faster than a 404, and a reader
//   arriving from an old link gets a short honest sentence rather than being
//   silently deposited on an index with no explanation of what they were
//   looking for.
//
// A 404 would also have been defensible and is what an unpublished row produces
// on its own. It is rejected because 404 means "we have nothing at this URL",
// which is indistinguishable from a typo or a bug, and this is neither.

/** Slugs that answered at /blog/:slug and have been deliberately withdrawn. */
export const WITHDRAWN_BLOG_SLUGS: readonly string[] = [
  "net-revenue-retention-guide",
  "subscription-intelligence-churn-prediction",
];

/** True when the slug names a post that was withdrawn rather than never existing. */
export function isWithdrawnBlogSlug(slug: string): boolean {
  return WITHDRAWN_BLOG_SLUGS.includes(slug);
}

// THE MESSAGE IS SPLIT SO ONE WORDING CAN SERVE TWO SHAPES (394 halt 4). The
// response body wants a sentence; the rendered page wants a heading and a
// paragraph under it, and repeating "This article has been withdrawn" in both
// slots reads as a stutter. Splitting is what lets the page stop saying
// "Something went wrong" over a deliberate act without the served text moving:
// WITHDRAWN_BLOG_MESSAGE is composed from these two and is byte-identical to
// the string it replaced, which the 391 test pins by comparing the response
// body against it.

/** The withdrawal itself. No trailing period: it is also the page's heading. */
export const WITHDRAWN_BLOG_HEADING = "This article has been withdrawn";

/** Why, in one clause, so a reader does not have to guess at a motive. */
export const WITHDRAWN_BLOG_REASON =
  "It relied on third-party figures we could no longer verify against their sources, and we would rather publish nothing than publish numbers we cannot stand behind.";

/** What a reader arriving on an old link is told. Short, and it says why. */
export const WITHDRAWN_BLOG_MESSAGE = `${WITHDRAWN_BLOG_HEADING}. ${WITHDRAWN_BLOG_REASON}`;
