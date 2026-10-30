import { Check } from "lucide-react";
import { Link } from "capsomer/react/link";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import "capsomer/empty.css";
import "capsomer/page-head.css";
import "capsomer/pagination.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/table.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /intelligence/customers does.
import "~/site-header.css";

import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { healthScoreClassName } from "~/lib/intelligence/health-band";
import type { RecommendedAction } from "~/lib/intelligence/recommend";
import {
  listActionableRecommendations,
  RECOMMENDATIONS_PAGE_SIZE,
  type RecommendationRow,
} from "~/lib/intelligence/recommendations.server";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/recommendations";
import { NOINDEX } from "~/lib/seo/meta";

// /intelligence/recommendations. Recova is the spec: its
// page, app/(app)/intelligence/recommendations/page.tsx at blob 4f03c7d6, and
// its read, fetchActionableRecommendations in
// lib/intelligence/customer-context-ssr.ts at blob a499c285, both read whole.
// In Recova's order and width: the head, then a card per section with its
// title, its line and a table (Customer, Plan, MRR, Health, Recommendation), or
// Recova's "No action needed right now." card, then the pager, in a 1280px
// column. Rows are the account's customers whose action asks for attention,
// highest MRR first, 50 to a page, grouped into sections within the page.
//
// The action is written by the nightly scoring batch from Recova's rules on
// Foxhound's data (app/lib/intelligence/recommend.ts). Recova's page read a
// field nothing ever wrote, so it was always empty for a real merchant.
//
// Two of Recova's three sections are here. "Expansion opportunity"
// (expansion_outreach) is not, and neither are the win-back priority and
// accept dispute loss rows Recova filed under the other two: no rule in Recova
// or Foxhound produces those actions, and a section over data nothing writes is
// not built.
//
// Recova's Plan column reads current_plan_tier, which nothing in Foxhound
// writes (signals.ts: no tier taxonomy), so it shows the plan's own name from
// Stripe, the product of the customer's largest subscription, as
// /intelligence/churn does.
//
// Built from Capsomer's parts, amber throughout. No Foxhound class sits
// on a Capsomer element. Recova's mono uppercase column heads and its 12px
// radius wait for Capsomer's per-site layer, as on the other Intelligence pages.

export function meta() {
  return [{ title: "Recommendations - Foxhound" }, NOINDEX];
}

interface Section {
  title: string;
  subtitle: string;
  actions: RecommendedAction[];
}

// Recova's SECTIONS, less the actions nothing produces (see above).
const SECTIONS: Section[] = [
  {
    title: "Reach out personally",
    subtitle: "High-value customers where automated email is unlikely to be enough.",
    actions: ["personal_outreach"],
  },
  {
    title: "Watch closely",
    subtitle: "Continue the automated path but keep a human eye on these.",
    actions: ["continue_automated_priority"],
  },
];

const ACTION_LABEL: Partial<Record<RecommendedAction, string>> = {
  personal_outreach: "Personal outreach",
  continue_automated_priority: "Watch closely",
};

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const pageParam = Number(new URL(request.url).searchParams.get("page") ?? "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;
  const { rows, totalCount } = await listActionableRecommendations(db, accountId, page);
  const totalPages = Math.max(1, Math.ceil(totalCount / RECOMMENDATIONS_PAGE_SIZE));

  return { rows, totalCount, page, totalPages };
}

function pageHref(page: number): string {
  return page > 1 ? `/intelligence/recommendations?page=${page}` : "/intelligence/recommendations";
}

export default function IntelligenceRecommendationsPage({ loaderData }: Route.ComponentProps) {
  const { rows, totalCount, page, totalPages } = loaderData;

  // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-8. The shell owns
  // the page's one <main>, so this is a plain wrapper.
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8">
      <div className="mb-6">
        <PageHead title="Recommendations" lead="Customers that need your attention right now." />
      </div>

      {totalCount === 0 ? (
        <NothingToDo />
      ) : (
        <div className="flex flex-col gap-6">
          {SECTIONS.map((section) => {
            const sectionRows = rows.filter((r) => section.actions.includes(r.recommendedAction));
            if (sectionRows.length === 0) return null;
            return <SectionTable key={section.title} section={section} rows={sectionRows} />;
          })}
        </div>
      )}

      {totalPages > 1 ? <Pager page={page} totalPages={totalPages} /> : null}
    </div>
  );
}

/** Recova's all-clear card: a green tick, its heading and its line, centered.
 *  Capsomer's Empty puts the title in a <p>, which would demote Recova's h2, so
 *  this is Capsomer's empty markup inside a panel with the heading kept (the
 *  same gap the churn and customers pages name). */
function NothingToDo() {
  return (
    <div className="cap-panel">
      <div className="cap-panel-body">
        <div className="cap-empty" data-kind="all-clear" data-flush="">
          <div className="cap-empty-media" aria-hidden="true">
            <Check width={40} height={40} strokeWidth={2} className="text-success-text" />
          </div>
          <div className="cap-empty-header">
            <h2 className="cap-empty-title">No action needed right now.</h2>
            <p className="cap-empty-text">
              All customers are on track. We will surface them here as soon as one needs a closer look.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTable({ section, rows }: { section: Section; rows: RecommendationRow[] }) {
  return (
    <Panel title={section.title} description={section.subtitle} flush>
      <div className="cap-table-wrap" data-cap="table" role="region" aria-label={section.title} tabIndex={0}>
        <table className="cap-table">
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
                  <Link className="cap-table-open" to={`/intelligence/customers/${c.stripeCustomerId}`}>
                    {c.customerName ?? "(unnamed)"}
                  </Link>
                  {/* Recova's second line under the name: the Stripe id, micro and mono. */}
                  <span className="block font-mono text-micro text-text-subtle">{c.stripeCustomerId}</span>
                </th>
                <td>
                  <Pill variant="outline">{c.planName ?? "-"}</Pill>
                </td>
                <td data-num="">
                  <span className="font-mono">
                    {c.mrrContributionCents > 0 ? formatMoney(c.mrrContributionCents, c.currency) : "-"}
                  </span>
                </td>
                <td data-num="">
                  {c.healthScore == null ? (
                    <span className="font-mono text-text-tertiary">-</span>
                  ) : (
                    <span className={`font-mono font-semibold ${healthScoreClassName(c.healthScore)}`}>
                      {c.healthScore}
                    </span>
                  )}
                </td>
                <td>
                  <span className="text-micro text-text-subtle">
                    {ACTION_LABEL[c.recommendedAction] ?? c.recommendedAction}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** Recova's pager: "Page N of M" on the left, Previous and Next on the right,
 *  each only when it leads somewhere, as /intelligence/customers draws it. */
function Pager({ page, totalPages }: { page: number; totalPages: number }) {
  return (
    <div className="mt-4">
      <nav className="cap-pagination" aria-label="Recommendation pages">
        <p className="cap-pagination-status">
          Page {page} of {totalPages}
        </p>
        <ul className="cap-pagination-list">
          {page > 1 ? (
            <li>
              <Link className="cap-page" data-kind="prev" to={pageHref(page - 1)} rel="prev">
                Previous
              </Link>
            </li>
          ) : null}
          {page < totalPages ? (
            <li>
              <Link className="cap-page" data-kind="next" to={pageHref(page + 1)} rel="next">
                Next
              </Link>
            </li>
          ) : null}
        </ul>
      </nav>
    </div>
  );
}
