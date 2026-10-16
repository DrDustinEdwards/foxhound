import type { Db } from "~/db";
import { getAllPublishedPosts } from "~/lib/blog/queries.server";

import { publishedSetOf, type PublishedSet } from "./published-set";

/** The one read every machine-readable file is built from (J61). */
export async function loadPublishedSet(db: Db): Promise<PublishedSet> {
  return publishedSetOf(await getAllPublishedPosts(db));
}
