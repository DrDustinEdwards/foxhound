import { RefusedError } from "@dustinedwards/site-api";
import { toPost, type BlogPost } from "~/lib/blog/queries.server";
import { SITE_ORIGIN } from "~/lib/seo/jsonld";
import { isSlug } from "@drdustinedwards/site-helpers/slug";
import { readingMinutes, wordCount } from "@drdustinedwards/site-helpers/text";

import { parse, fieldsOf, type Post } from "./post-model.server";

/**
 * The site's own render of a route (workers/app.ts), with the draft on its
 * context; nothing stored or cached.
 */
export type RenderDocument = (request: Request, draft: BlogPost) => Promise<Response>;

/**
 * The draft through the post's own route and layout, in-process
 * (workers/app.ts), so it has the site's header and footer and everything
 * the page shows.
 */
export async function renderPreview(
  renderDocument: RenderDocument | undefined,
  { id, source }: { id?: string | null; source: string },
  load: (id: string) => Promise<Post | null>,
): Promise<string> {
  if (!renderDocument) throw new Error("the document renderer is not on this request");
  const post = parse(source, { preview: true });
  const current = id ? ((await load(id))?.row ?? null) : null;
  const slug = current?.slug ?? post.slug ?? (id && isSlug(id) ? id : "preview");
  const now = new Date();
  const response = await renderDocument(
    new Request(new URL(`/blog/${slug}`, SITE_ORIGIN), { headers: { Accept: "text/html" } }),
    toPost({
      id: current?.id ?? id ?? slug,
      slug,
      ...fieldsOf(post, {
        coverImageUrl: current?.coverImageUrl ?? null,
        coverImageAlt: current?.coverImageAlt ?? null,
        showUpdatedAt: current?.showUpdatedAt ?? true,
        showPublishedAt: current?.showPublishedAt ?? true,
      }),
      published: current?.published ?? false,
      publishedAt: current?.publishedAt ?? null,
      createdAt: current?.createdAt ?? now,
      updatedAt: current?.updatedAt ?? now,
      readingMinutes: readingMinutes(wordCount(post.body)),
      trashedAt: null,
    }),
  );
  if (!response.ok)
    throw new RefusedError(
      `The preview did not render: /blog/${slug} answered ${response.status}.`,
    );
  // The page's own robots tag indexes it; the strictest wins, so this
  // keeps a preview out of every index.
  return (await response.text()).replace(
    /<head\b[^>]*>/i,
    (head) => `${head}<meta name="robots" content="noindex, nofollow">`,
  );
}
