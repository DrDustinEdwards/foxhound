import { Link } from "capsomer/react/link";

import { MarketingPageHeader } from "~/components/marketing-page-header";
import { DISPUTE_FEE_PERCENT, RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { COMPETITORS } from "~/lib/compare/competitors";
import { RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/competitor";
import "capsomer/table.css";

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
  return [
    ...marketingMeta({
      title: `Foxhound vs ${competitor.name}`,
      description: `How Foxhound compares to ${competitor.name}: pricing model, what each product does, and honest tradeoffs.`,
      path: `/compare/${competitor.slug}`,
      siteUrl: url,
    }),
  ];
}

export default function ComparePage({ loaderData }: Route.ComponentProps) {
  const { competitor } = loaderData;

  return (
    <div>
      <MarketingPageHeader
        trail={[{ label: "Compare", href: "/compare" }, { label: `Foxhound vs ${competitor.name}` }]}
        eyebrow="Compare"
        title={`Foxhound vs ${competitor.name}`}
        subtext={competitor.oneLiner}
      />

      <div className="mx-auto max-w-4xl px-4 pb-16 sm:px-8">
        <div
          className="cap-table-wrap mb-10 rounded-lg border border-border"
          data-cap="table"
          data-reflow=""
          role="region"
          aria-label={`Foxhound vs ${competitor.name}`}
          tabIndex={0}
        >
          <table className="cap-table">
            <thead>
              <tr>
                <th scope="col">Dimension</th>
                <th scope="col">Foxhound</th>
                <th scope="col">{competitor.name}</th>
              </tr>
            </thead>
            <tbody>
              {competitor.rows.map((row) => (
                <tr key={row.dimension}>
                  <th scope="row" className="align-top font-medium text-text">
                    {row.dimension}
                  </th>
                  <td data-label="Foxhound" className="align-top leading-relaxed text-text-secondary">
                    {row.foxhound}
                  </td>
                  <td data-label={competitor.name} className="align-top leading-relaxed text-text-secondary">
                    {row.competitor}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="mb-10 rounded-lg border border-border bg-surface p-5">
          <h2 className="mb-3 text-title font-medium text-text">
            Where Foxhound is behind
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-label leading-relaxed text-text-secondary">
            {competitor.foxhoundCons.map((con) => (
              <li key={con} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-text-tertiary"
                />
                <span>{con}</span>
              </li>
            ))}
          </ul>
        </section>

        {competitor.priceSource ? (
          <p className="mb-4 text-label text-text-tertiary">
            {competitor.name} pricing:{" "}
            <a
              href={competitor.priceSource.url}
              rel="noopener noreferrer"
              className="underline"
            >
              {competitor.priceSource.url}
            </a>
            , read {competitor.priceSource.checked}.
          </p>
        ) : null}

        {competitor.omittedNote ? (
          <p className="mb-10 text-label text-text-tertiary">
            {competitor.omittedNote}
          </p>
        ) : null}

        <div className="rounded-lg border border-border bg-surface p-6 text-center">
          <p className="mb-2 text-body font-medium text-text">
            See Foxhound's pricing in full
          </p>
          <p className="mb-5 text-label text-text-secondary">
            {RECOVERY_FEE_PERCENT}% of Foxhound-attributed recoveries,{" "}
            {DISPUTE_FEE_PERCENT}% of won disputes with a cap, and Intelligence
            free. No fee until a recovery has matured {RECOVERY_MATURITY_DAYS}{" "}
            days.
          </p>
          <Link
            to="/pricing"
            className="inline-flex items-center gap-2 rounded-md bg-brand px-5 py-2.5 text-label font-medium text-on-brand hover:bg-brand-dark"
          >
            View pricing
          </Link>
        </div>
      </div>
    </div>
  );
}
