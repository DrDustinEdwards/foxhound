import { ArrowLeft } from "lucide-react";
import { Link } from "capsomer/react/link";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { COMPETITORS } from "~/lib/compare/competitors";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { breadcrumbListJsonLd, siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/competitor";

// NEW in Phase 6 Pass 3 (net-new). Templated Foxhound-vs-competitor page for
// each of the six named competitors (ROUTES.md Rev 2). Neither Capsid
// content doc (checked at session start and again before writing this file)
// existed, so the row-level copy in app/lib/compare/competitors.ts is this
// pass's own researched, source-checked writing (see that file's header
// comment), not a dedicated content pass's copy; it is still real content,
// not a placeholder shell, since every claim there is either grounded in a
// well-known public fact or explicitly marked omitted.
export function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const competitor = COMPETITORS[params.competitor];
  if (!competitor) {
    throw new Response("Not found", { status: 404 });
  }
  return { siteUrl: siteUrl(env), competitor };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "Compare - Foxhound" }];
  const { competitor, siteUrl: url } = loaderData;
  return marketingMeta({
    title: `Foxhound vs ${competitor.name} - Foxhound`,
    description: `How Foxhound compares to ${competitor.name}: pricing model, what each product does, and honest tradeoffs.`,
    path: `/compare/${competitor.slug}`,
    siteUrl: url,
  });
}

export default function ComparePage({ loaderData }: Route.ComponentProps) {
  const { siteUrl: url, competitor } = loaderData;

  return (
    <div>
      <MarketingPageHeader
        eyebrow="Compare"
        title={`Foxhound vs ${competitor.name}`}
        subtext={competitor.oneLiner}
      />

      <div className="mx-auto max-w-4xl px-4 pb-16 sm:px-8">
        <Link
          to="/compare"
          className="group mb-8 inline-flex items-center gap-1.5 text-label text-text-tertiary hover:text-text"
        >
          <ArrowLeft className="transition-transform group-hover:-translate-x-0.5" size={13} strokeWidth={1.5} aria-hidden />
          Back to comparisons
        </Link>

        <div className="mb-10 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] border-collapse text-label">
            <thead>
              <tr className="border-b border-border bg-surface2">
                <th className="px-4 py-3 text-left font-mono text-micro uppercase tracking-wide text-text-tertiary">Dimension</th>
                <th className="px-4 py-3 text-left font-mono text-micro uppercase tracking-wide text-text-tertiary">Foxhound</th>
                <th className="px-4 py-3 text-left font-mono text-micro uppercase tracking-wide text-text-tertiary">{competitor.name}</th>
              </tr>
            </thead>
            <tbody>
              {competitor.rows.map((row, i) => (
                <tr key={row.dimension} className={i % 2 === 1 ? "bg-surface" : undefined}>
                  <td className="px-4 py-3 align-top font-medium text-text">{row.dimension}</td>
                  <td className="px-4 py-3 align-top leading-relaxed text-text-secondary">{row.foxhound}</td>
                  <td className="px-4 py-3 align-top leading-relaxed text-text-secondary">{row.competitor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="mb-10 rounded-lg border border-border bg-surface p-5">
          <h2 className="mb-3 text-title font-medium text-text">Where Foxhound is behind</h2>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-label leading-relaxed text-text-secondary">
            {competitor.foxhoundCons.map((con) => (
              <li key={con} className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-text-tertiary" />
                <span>{con}</span>
              </li>
            ))}
          </ul>
        </section>

        {competitor.omittedNote ? (
          <p className="mb-10 text-label text-text-tertiary">{competitor.omittedNote}</p>
        ) : null}

        <div className="rounded-lg border border-border bg-surface p-6 text-center">
          <p className="mb-2 text-body font-medium text-text">See Foxhound's pricing in full</p>
          <p className="mb-5 text-label text-text-secondary">
            20% of Foxhound-attributed recoveries, capped disputes, a free Intelligence tier. No fee until a
            recovery has matured 30 days.
          </p>
          <Link
            to="/pricing"
            className="inline-flex items-center gap-2 rounded-md bg-brand px-5 py-2.5 text-label font-medium text-on-brand hover:bg-brand-dark"
          >
            View pricing
          </Link>
        </div>
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            breadcrumbListJsonLd(url, [
              { name: "Home", path: "/" },
              { name: "Compare", path: "/compare" },
              { name: competitor.name, path: `/compare/${competitor.slug}` },
            ]),
          ),
        }}
      />
    </div>
  );
}
