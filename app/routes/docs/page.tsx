import { slugify } from "@drdustinedwards/site-helpers/slug";
import { Breadcrumb } from "capsomer/react/breadcrumb";
import { Link } from "capsomer/react/link";

import { DocBlocks } from "~/components/docs/doc-blocks";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getDocGuide } from "~/lib/marketing/docs-content";
import { breadcrumbListJsonLd, siteUrl, techArticleJsonLd } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import "capsomer/banner.css";
import "capsomer/breadcrumb.css";
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
      title: `${guide.title} - Foxhound docs`,
      description: guide.description,
      path: `/docs/${guide.slug}`,
      siteUrl: url,
    }),
    jsonLd(techArticleJsonLd(url, {
      headline: guide.heading,
      description: guide.description,
      path: `/docs/${guide.slug}`,
      datePublished: guide.datePublished,
    })),
    jsonLd(breadcrumbListJsonLd(url, [
      { name: "Docs", path: "/docs" },
      { name: guide.title, path: `/docs/${guide.slug}` },
    ])),
  ];
}

/** Recova's RelLink and TOC link: amber, underlined. */
const LINK = "text-accent-text underline underline-offset-2 hover:opacity-80";

export default function DocGuidePage({ loaderData }: Route.ComponentProps) {
  const { guide } = loaderData;
  const sectionIds = guide.sections.map((section) => slugify(section.heading));

  return (
    <div className="fh-cap mx-auto max-w-[760px] px-6 py-16 [--border-focus:var(--ring)]" data-cap-site="foxhound" data-family="amber">
      {/* Recova's crumbs are quiet: tertiary, the link lighting up under the pointer. */}
      <div className="mb-8 [&_.cap-breadcrumb]:text-micro [&_.cap-breadcrumb]:text-text-tertiary [&_.cap-breadcrumb-page]:font-normal [&_.cap-breadcrumb-page]:text-text-tertiary [&_a:hover]:text-text [&_a]:text-text-tertiary [&_a]:no-underline">
        <Breadcrumb
          items={[{ label: "Docs", href: "/docs" }, { label: guide.title }]}
          renderLink={({ href, className, children }) => (
            <Link to={href} className={className}>
              {children}
            </Link>
          )}
        />
      </div>

      <div className="mb-3 text-micro font-medium uppercase tracking-widest text-text-tertiary">User Guide</div>
      <h1 className="mb-3 text-page-title font-medium tracking-tight text-text">{guide.heading}</h1>
      <p className="mb-10 text-subhead leading-relaxed text-text-secondary">{guide.lead}</p>

      {guide.sections.length > 1 ? (
        <nav aria-label="Contents" className="cap-panel mb-12 rounded-lg [--gap:1.25rem] [--pad-card:1.25rem]">
          <div className="cap-panel-body">
            <div>
              <div className="mb-3 font-mono text-micro uppercase tracking-[0.06em] text-text-tertiary">Contents</div>
              <ol className="m-0 grid list-none grid-cols-1 gap-x-6 gap-y-1.5 p-0 sm:grid-cols-2">
                {guide.sections.map((section, i) => (
                  <li key={section.heading} className="text-label leading-6">
                    <a href={`#${sectionIds[i]}`} className={LINK}>
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
          <div className="mb-2 mt-16 text-micro font-medium uppercase tracking-widest text-accent-text">
            Part {i + 1}
          </div>
          <h2 id={sectionIds[i]} className="mb-6 scroll-mt-20 text-title font-medium text-text">
            {section.heading}
          </h2>
          <DocBlocks blocks={section.body} />
        </section>
      ))}
    </div>
  );
}
