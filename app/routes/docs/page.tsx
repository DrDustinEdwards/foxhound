import { Link } from "react-router";

import { cloudflareContext } from "~/lib/cloudflare-context";
import { getDocGuide } from "~/lib/marketing/docs-content";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/page";

// Ported from legacy docs/{platform,audit,recovery,disputes,intelligence}/page.tsx
// (Phase 6 Pass 1), collapsed onto a single dynamic :slug route backed by
// app/lib/marketing/docs-content.ts instead of five separate route files.
//
// TOC + breadcrumb restored (TASK-foxhound-parity-cluster-b.md fix 2).
// Diagnosed first, per the task's ground-truth rule: docs pages are NOT
// markdown-rendered (unlike blog posts), they render DOC_GUIDES's own
// sections array directly, so there is no parser/renderer bug demoting or
// dropping headings. Confirmed live on recova-eta.vercel.app/docs/platform:
// legacy has a bordered "Contents" nav linking to each H2 section by id
// ("Part 1. Getting started", etc.) and a "Docs -> Platform" breadcrumb
// back to /docs. Both are restored below, using ids generated from this
// repo's own section headings (not legacy's, since the headings
// themselves differ - this repo's platform guide is "Connecting Stripe" /
// "Billing" / "Team and brand voice", not legacy's "Getting started" /
// "Additional features" / "Settings reference").
//
// What this does NOT restore: legacy's H3 subsections within each H2 (its
// platform guide alone has 9 - disconnecting Stripe, sender name, reply-to
// email, expiring-card alerts, win-back sequences, weekly digest, Slack
// notifications, team roles, cancellation - none of which exist in
// DOC_GUIDES). That is a genuine content gap (legacy: 28 headings across 5
// guides; this repo: 4-5 per guide), but it is a content-authoring effort,
// not a renderer bug: the DocGuide schema has exactly one heading level
// (H2) per section by original design (this file's own header above calls
// the content "deliberately smaller... not the full 5-guide legacy
// library"). Flagged to whoever owns docs content rather than fabricated
// here - matching this codebase's standing rule against inventing
// unverified content (same discipline applied to audit.tsx's recovery-rate
// figures and the blog remediation's brand-token pass).
//
// Also fixes a duplicate <main> landmark noticed while rewriting this
// component: app/layouts/marketing.tsx already renders the page's one
// <main>, so this component's own top-level wrapper is a <div>, not a
// second nested <main> (the same bug pattern the parity audit found on
// /login and /blog/tag/:tag).

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

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
  return marketingMeta({
    title: `${guide.title} - Foxhound docs`,
    description: guide.description,
    path: `/docs/${guide.slug}`,
    siteUrl: url,
  });
}

export default function DocGuidePage({ loaderData }: Route.ComponentProps) {
  const { guide } = loaderData;
  const sectionIds = guide.sections.map((section) => slugify(section.heading));

  return (
    <div>
      <div className="border-b border-border-sub px-4 py-16 text-center sm:px-8">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Docs</p>
        <h1 className="mt-3 text-display font-medium text-text">{guide.title}</h1>
        <p className="mx-auto mt-3 max-w-xl text-body text-text-secondary">{guide.description}</p>
      </div>

      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-8">
        <nav aria-label="Breadcrumb" className="mb-8 font-mono text-micro text-text-tertiary">
          <Link to="/docs" className="hover:text-text">
            Docs
          </Link>
          <span className="mx-2" aria-hidden="true">
            &rarr;
          </span>
          <span>{guide.title}</span>
        </nav>

        {guide.sections.length > 1 ? (
          <nav aria-label="Contents" className="mb-10 rounded-lg border border-border bg-surface p-5">
            <p className="mb-3 font-mono text-micro uppercase tracking-wide text-text-tertiary">Contents</p>
            <ol className="m-0 grid list-none grid-cols-1 gap-1.5 p-0 sm:grid-cols-2">
              {guide.sections.map((section, i) => (
                <li key={section.heading}>
                  <a href={`#${sectionIds[i]}`} className="text-label text-text-secondary hover:text-text">
                    Part {i + 1}. {section.heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        <div className="flex flex-col gap-10">
          {guide.sections.map((section, i) => (
            <section key={section.heading}>
              <h2 id={sectionIds[i]} className="mb-3 scroll-mt-20 text-title font-medium text-text">
                {section.heading}
              </h2>
              <div className="flex flex-col gap-3 text-body leading-relaxed text-text-secondary">
                {section.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
