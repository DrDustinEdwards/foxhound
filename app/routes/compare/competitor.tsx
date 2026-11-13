import { publicPageHeaders } from "@dustinedwards/site-runtime/edge-cache";
import { Link } from "capsomer/react/link";

import { CARD, CARD_MD } from "~/components/marketing-card";
import { MarketingPageHeader } from "~/components/marketing-page-header";
import { DISPUTE_FEE_PERCENT, RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import { COMPETITORS } from "~/lib/compare/competitors";
import { RECOVERY_MATURITY_DAYS } from "~/lib/constants";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { siteUrl } from "~/lib/seo/jsonld";
import { marketingMeta } from "~/lib/seo/meta";

import type { Route } from "./+types/competitor";
import "capsomer/table.css";
import "capsomer/button.css";
import "capsomer/panel.css";
import "~/reference.css";

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
    // Capsomer's amber family with Foxhound's own neutrals (.fh-cap, as /blog):
    // the panels, the button and the focus ring read the family.
    <div className="fh-cap" data-cap-site="foxhound" data-family="amber">
      <MarketingPageHeader
        trail={[
          { label: "Compare", href: "/compare" },
          { label: `Foxhound vs ${competitor.name}` },
        ]}
        eyebrow="Compare"
        title={`Foxhound vs ${competitor.name}`}
        subtext={competitor.oneLiner}
      />

      <div className="fh-rival-wrap">
        <div
          className="fh-rival-block-2 cap-table-wrap"
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
                  <th scope="row" className="fh-rival-th fh-medium fh-text">
                    {row.dimension}
                  </th>
                  <td data-label="Foxhound" className="fh-rival-th fh-relaxed fh-soft">
                    {row.foxhound}
                  </td>
                  <td data-label={competitor.name} className="fh-rival-th fh-relaxed fh-soft">
                    {row.competitor}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className={`fh-rival-band ${CARD_MD}`}>
          <div className="cap-panel-body">
            <div>
              <h2 className="fh-rival-title fh-title fh-medium fh-text">
                Where Foxhound is behind
              </h2>
              <ul className="fh-rival-list fh-small fh-relaxed fh-soft">
                {competitor.foxhoundCons.map((con) => (
                  <li key={con} className="fh-mk-point">
                    <span aria-hidden="true" className="fh-rival-label" />
                    <span>{con}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {competitor.priceSource ? (
          <p className="fh-rival-text fh-small fh-quiet">
            {competitor.name} pricing:{" "}
            <a href={competitor.priceSource.url} rel="external noopener noreferrer">
              {competitor.priceSource.url}
            </a>
            , read {competitor.priceSource.checked}.
          </p>
        ) : null}

        {competitor.omittedNote ? (
          <p className="fh-rival-band fh-small fh-quiet">{competitor.omittedNote}</p>
        ) : null}

        <div className={`${CARD} fh-center`}>
          <div className="cap-panel-body">
            <div>
              <p className="fh-rival-text-2 fh-body fh-medium fh-text">
                See Foxhound's pricing in full
              </p>
              <p className="fh-rival-text-3 fh-small fh-soft">
                {RECOVERY_FEE_PERCENT}% of Foxhound-attributed recoveries, {DISPUTE_FEE_PERCENT}% of
                won disputes with a cap, and Intelligence free. No fee until a recovery has matured{" "}
                {RECOVERY_MATURITY_DAYS} days.
              </p>
              <Link to="/pricing" className="cap-btn" data-variant="primary">
                View pricing
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const headers = () => publicPageHeaders();
