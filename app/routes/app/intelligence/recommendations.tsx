import { Table } from "capsomer/react/table";
import { Icon, iconCheck } from "capsomer/react/icons";
import { Link, routerRenderLink } from "capsomer/react/link";
import { PageHead } from "capsomer/react/page-head";
import { Pagination, pageCountOf, pageHref, parsePage } from "capsomer/react/pagination";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import "capsomer/empty.css";
import "capsomer/page-head.css";
import "capsomer/pagination.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/table.css";
// Capsomer's tokens and the amber family, which the components above read. The shell loads the same file through its header; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import { accountScope } from "~/lib/auth/context";
import { healthScoreClassName } from "~/lib/intelligence/health-band";
import type { RecommendedAction } from "~/lib/intelligence/recommend";
import {
  listActionableRecommendations,
  RECOMMENDATIONS_PAGE_SIZE,
  type RecommendationRow,
} from "~/lib/intelligence/recommendations.server";
import { formatMoney } from "@dustinedwards/site-runtime/money";

import type { Route } from "./+types/recommendations";
import { noindexMeta } from "~/lib/seo/meta";

// /intelligence/recommendations: the head, then a card per section with its title, its line and a table (Customer, Plan, MRR, Health, Recommendation), or a "No action needed right now." card, then the pager, in a 1280px column. Rows are the account's customers whose action asks for attention, highest MRR first, 50 to a page, grouped into sections within the page. The action is written by the nightly scoring batch from the rules in app/lib/intelligence/recommend.ts. Only the sections some rule produces are here; a section over data nothing writes is not built. The Plan column shows the plan's own name from Stripe, the product of the customer's largest subscription, as /intelligence/churn does (nothing in Foxhound writes current_plan_tier). No Foxhound class sits on a Capsomer element.

export const meta = noindexMeta("Recommendations - Foxhound");

interface Section {
  title: string;
  actions: RecommendedAction[];
}

// The sections, less the actions nothing produces (see above).
const SECTIONS: Section[] = [
  {
    title: "Reach out personally",
    actions: ["personal_outreach"],
  },
  {
    title: "Watch closely",
    actions: ["continue_automated_priority"],
  },
];

const ACTION_LABEL: Partial<Record<RecommendedAction, string>> = {
  personal_outreach: "Personal outreach",
  continue_automated_priority: "Watch closely",
};

export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, accountId } = accountScope(context);

  const page = parsePage(new URL(request.url).searchParams.get("page"));
  const { rows, totalCount } = await listActionableRecommendations(db, accountId, page);
  const totalPages = pageCountOf(totalCount, RECOMMENDATIONS_PAGE_SIZE);

  return { rows, totalCount, page, totalPages };
}

const recommendationsHref = (page: number) => pageHref("/intelligence/recommendations", {}, page);

export default function IntelligenceRecommendationsPage({ loaderData }: Route.ComponentProps) {
  const { rows, totalCount, page, totalPages } = loaderData;

  // max-w-[1280px] mx-auto px-4 md:px-8 py-8. The shell owns the page's one <main>, so this is a plain wrapper.
  return (
    <div className="fh-intel-page cap-admin-page" data-width="page">
      <div className="fh-intel-head">
        <PageHead title="Recommendations" />
      </div>

      {totalCount === 0 ? (
        <NothingToDo />
      ) : (
        <div className="cap-stack" data-gap="6">
          {SECTIONS.map((section) => {
            const sectionRows = rows.filter((r) => section.actions.includes(r.recommendedAction));
            if (sectionRows.length === 0) return null;
            return <SectionTable key={section.title} section={section} rows={sectionRows} />;
          })}
        </div>
      )}

      {totalPages > 1 ? (
        <div className="fh-pager">
          <Pagination
            form="steps"
            page={page}
            pageCount={totalPages}
            hrefFor={recommendationsHref}
            renderLink={routerRenderLink}
            label="Recommendation pages"
          />
        </div>
      ) : null}
    </div>
  );
}

/** The all-clear card: a green tick, its heading and its line, centered. Capsomer's Empty puts the title in a <p>, which would demote the h2, so this is Capsomer's empty markup inside a panel with the heading kept. */
function NothingToDo() {
  return (
    <div className="cap-panel">
      <div className="cap-panel-body">
        <div className="cap-empty" data-kind="all-clear" data-flush="">
          <div className="cap-empty-media" aria-hidden="true">
            <Icon d={iconCheck} className="fh-icon-40 fh-success" />
          </div>
          <div className="cap-empty-header">
            <h2 className="cap-empty-title">No action needed right now.</h2>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTable({ section, rows }: { section: Section; rows: RecommendationRow[] }) {
  return (
    <Panel title={section.title} flush>
      <Table caption={section.title} captionHidden reflow="medium">
        <thead>
          <tr>
            <th scope="col">Customer</th>
            <th scope="col">Plan</th>
            <th scope="col" data-num="">
              MRR
            </th>
            <th scope="col" data-num="">
              Health
            </th>
            <th scope="col">Recommendation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.stripeCustomerId}>
              <th scope="row">
                <Link
                  className="cap-table-open"
                  to={`/intelligence/customers/${c.stripeCustomerId}`}
                >
                  {c.customerName ?? "(unnamed)"}
                </Link>
                <span className="fh-line fh-mono fh-tiny fh-faint">{c.stripeCustomerId}</span>
              </th>
              <td data-label="Plan">
                <Pill variant="outline">{c.planName ?? "-"}</Pill>
              </td>
              <td data-label="MRR" data-num="">
                <span className="fh-mono">
                  {c.mrrContributionCents > 0
                    ? formatMoney(c.mrrContributionCents, c.currency)
                    : "-"}
                </span>
              </td>
              <td data-label="Health" data-num="">
                {c.healthScore == null ? (
                  <span className="fh-mono fh-quiet">-</span>
                ) : (
                  <span className={`fh-mono fh-semibold ${healthScoreClassName(c.healthScore)}`}>
                    {c.healthScore}
                  </span>
                )}
              </td>
              <td data-label="Recommendation">
                <span className="fh-tiny fh-faint">
                  {ACTION_LABEL[c.recommendedAction] ?? c.recommendedAction}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}
