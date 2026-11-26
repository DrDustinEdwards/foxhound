import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { plural } from "@drdustinedwards/site-helpers/text";
import { BlogPostCard } from "~/components/blog/blog-post-card";
import { getDb } from "~/db";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { labelForTag } from "~/lib/blog/tags";
import { getPublishedPostsByTag, getPublishedTagSet } from "~/lib/blog/queries.server";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/panel.css";
import "capsomer/status.css";
// Capsomer's tokens and the amber family (capbase layer), which the cards, the pills and the focus ring read. The site header loads the same file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import type { Route } from "./+types/tag";
import { SectionTrail } from "~/components/section-trail";
import "~/blog-index.css";

// An UNKNOWN tag 404s: a not-found URL answering 200 asserts the page exists, and the other unknown-slug surfaces (posts, decline codes, competitors, docs guides, unknown paths) all 404, and an empty archive must not look like a garbage URL to a crawler following llms.txt. The gate is the published tag set (getPublishedTagSet, the one derivation llms.txt, llms-full.txt and the archive pills read), so a tag page exists exactly when a published post carries the tag.
export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = getDb(env);
  const tag = params.tag;
  const tagSet = await getPublishedTagSet(db);
  if (!tagSet.includes(tag)) {
    throw new Response("Not found", { status: 404 });
  }
  const posts = await getPublishedPostsByTag(db, tag);
  return { siteUrl: siteUrl(env), tag, posts };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Blog - Foxhound" }];
  const label = labelForTag(loaderData.tag);
  return [
    ...marketingMeta({
      title: label,
      suffix: " - Foxhound Blog",
      description: `Every Foxhound blog guide on ${label}, written for Stripe merchants: what goes wrong, why, and the steps to fix it.`,
      path: `/blog/tag/${loaderData.tag}`,
      pageType: "CollectionPage",
      siteUrl: loaderData.siteUrl,
    }),
  ];
}

// Layout: one left-aligned column at 1100px (px-5, sm:px-8, py-16), the "All posts" back link (mb-8), the tag's label as the h1 (mb-2), the "N articles" count line (mb-10), then the card grid (1, 2, 3 columns, gap-6). The empty line is kept only for a post unpublished between the loader's two reads. Sizes: the 1.75rem h1, the 0.8125rem back link and count line. Cards are Capsomer's panel (BlogPostCard), the color amber, and the back link a 24px target.
export default function BlogTagPage({ loaderData }: Route.ComponentProps) {
  const { tag, posts } = loaderData;
  const label = labelForTag(tag);

  return (
    // div, not main: marketing.tsx already renders this page's one main landmark.
    // Capsomer's amber family with Foxhound's own neutrals (.fh-cap), the focus
    // ring reading the family's ring, as on /blog.
    <div className="fh-cap" data-cap-site="foxhound" data-family="amber">
      <div className="fh-mk-band-wrap">
        <SectionTrail items={[{ label: "Blog", href: "/blog" }, { label }]} />
        <h1 className="fh-tag-title fh-section fh-medium fh-text">{label}</h1>
        <p className="fh-mb-7-5 fh-mono fh-small fh-quiet">{plural(posts.length, "article")}</p>
        {posts.length === 0 ? (
          <p className="fh-body fh-soft">No articles tagged {label} yet.</p>
        ) : (
          <div className="fh-tag-grid">
            {posts.map((post) => (
              <BlogPostCard key={post.id} post={post} level={2} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const headers = () => publicPageHeaders();
