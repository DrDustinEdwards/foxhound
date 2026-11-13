import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { slugify } from "@drdustinedwards/site-helpers/slug";

import { DocBlocks } from "~/components/docs/doc-blocks";
import { SectionTrail } from "~/components/section-trail";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { getDocGuide } from "~/lib/marketing/docs-content";
import { siteUrl, techArticleJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/banner.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/table.css";
// Capsomer's tokens and the amber family (capbase layer), which every part on
// this page reads. The site header loads the same file; importing it here keeps
// the page whole under any layout (as /docs does, J17).
import "~/site-header.css";

import type { Route } from "./+types/page";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";

// The five docs guides on one :slug route. Recova's spec is
// app/(marketing)/docs/{platform,audit,recovery,disputes,intelligence}/page.tsx
// (blobs 2b69517b, 3b1153b4, 6166a6be, 598fcbaa, e7f18266), read whole.
//
// LAYOUT IS RECOVA'S: the 760px column with px-6 and py-16, the breadcrumb, the
// "User Guide" eyebrow, the page heading and lead, the Contents card with
// "Part N." links in two columns from sm, and each Part's amber eyebrow over its
// h2. LOOK IS CAPSOMER'S: the breadcrumb, the Contents card (a body-only
// panel), the tables, callouts and pills, in the amber family, with text
// at Recova's sizes. CONTENT is app/lib/marketing/docs-content.ts.
//
// The page heading and lead are Recova's page's own ("Platform setup",
// "Recovery sequences"), which differ from the /docs card's title and
// description; the breadcrumb keeps the card's short title, as Recova's does.
//
// Ids are generated from Foxhound's section headings. The wrapper is a div: the
// marketing layout already renders the page's one <main>.

export function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const guide = getDocGuide(params.slug);
  if (!guide) {
    throw new Response("Not found", { status: 404 });
  }
  return { siteUrl: siteUrl(env), guide };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Docs - Foxhound" }];
  const { guide, siteUrl: url } = loaderData;
  // JSON-LD (368 roadmap item 2): one block, an array of two. The headline
  // is the same value the h1 renders, so the two cannot drift.
  return [
    ...marketingMeta({
      title: guide.title,
      suffix: " - Foxhound docs",
      description: guide.description,
      path: `/docs/${guide.slug}`,
      siteUrl: url,
    }),
    jsonLd(
      techArticleJsonLd(url, {
        headline: guide.heading,
        description: guide.description,
        path: `/docs/${guide.slug}`,
        datePublished: guide.datePublished,
      }),
    ),
  ];
}

export default function DocGuidePage({ loaderData }: Route.ComponentProps) {
  const { guide } = loaderData;
  const sectionIds = guide.sections.map((section) => slugify(section.heading));

  return (
    <div
      className="fh-cap mx-auto max-w-[760px] px-6 py-16"
      data-cap-site="foxhound"
      data-family="amber"
    >
      <SectionTrail items={[{ label: "Docs", href: "/docs" }, { label: guide.title }]} />

      <div className="mb-3 fh-tiny fh-medium fh-quiet fh-caps-wide">User Guide</div>
      <h1 className="mb-3 fh-page-title fh-medium tracking-tight fh-text">{guide.heading}</h1>
      <p className="mb-10 fh-subhead fh-relaxed fh-soft">{guide.lead}</p>

      {guide.sections.length > 1 ? (
        <nav
          aria-label="Contents"
          className="cap-panel mb-12 rounded-lg [--gap:1.25rem] [--pad-card:1.25rem]"
        >
          <div className="cap-panel-body">
            <div>
              <div className="mb-3 fh-mono fh-tiny uppercase tracking-[0.06em] fh-quiet">
                Contents
              </div>
              <ol className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {guide.sections.map((section, i) => (
                  <li key={section.heading} className="fh-small leading-6">
                    <a href={`#${sectionIds[i]}`}>
                      Part {i + 1}. {section.heading}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </nav>
      ) : null}

      {guide.sections.map((section, i) => (
        <section key={section.heading}>
          <div className="mb-2 mt-16 fh-tiny fh-medium fh-accent fh-caps-wide">Part {i + 1}</div>
          <h2 id={sectionIds[i]} className="mb-6 scroll-mt-20 fh-title fh-medium fh-text">
            {section.heading}
          </h2>
          <DocBlocks blocks={section.body} />
        </section>
      ))}
    </div>
  );
}

export const headers = () => publicPageHeaders();
