import { Scale } from "lucide-react";
import { Form, Link } from "react-router";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import "capsomer/button.css";
import "capsomer/empty.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/pagination.css";
import "capsomer/panel.css";
import "capsomer/select.css";
import "capsomer/status.css";
import "capsomer/table.css";
// Capsomer's tokens and the teal family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /disputes does.
import "~/site-header.css";

import { IntelligenceUpsell } from "~/components/intelligence-upsell";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import {
  capitalizeTier,
  formatRelativeLastSeen,
  hasActiveRecoverySignal,
  hasDisputeHistorySignal,
  planTierPill,
} from "~/lib/intelligence/customer-directory";
import { healthScoreClassName } from "~/lib/intelligence/health-band";
import { isIntelligenceEntitled } from "~/lib/intelligence/views.server";
import { listCustomerDirectory, listCustomerTiers, type CustomerDirectorySort } from "~/lib/intelligence/directory.server";
import type { HealthScoreBand } from "~/lib/intelligence/health-band";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/customers";

// /intelligence/customers (row S17, job J30). Recova is the spec: its real
// page, app/(app)/intelligence/customers/page.tsx at blob 0413f035, with
// lib/intelligence-display.ts at blob 379635a7, both read whole. In Recova's
// order and width: the head (the account's name, the count line, the lead),
// then the table or Recova's "No customer data yet" card, then the pager, in a
// 1280px column.
//
// Built from Capsomer 0.9.0's parts (Q10), teal throughout, with no warm accent (Q11).
// No Foxhound class sits on a Capsomer element: where the page needs Recova's
// mono figures, its label size or its spacing, the class goes on an element of
// the page's own inside or around the Capsomer part. Recova's mono uppercase
// column heads, its plan colours on the pill's edge and its 12px radius wait
// for Capsomer's per-site layer (capsomer job_ec5ec0754626), listed in the J30
// notes.
//
// One Foxhound addition, approved: the filter bar ("The customers page has a
// filter bar. "confirm", 2026-08-28", APPROVED-DIFFERENCES). The
// recommended-action chip after the name waits for its producer (J78, row
// S20); test/customers-heading-399.test.ts holds that halt.

export function meta() {
  return [{ title: "Customers - Foxhound" }];
}

const HEALTH_BANDS: HealthScoreBand[] = ["healthy", "watch", "at_risk"];
const HEALTH_BAND_LABEL: Record<HealthScoreBand, string> = {
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
};

function parseHealthBand(value: string | null): HealthScoreBand | null {
  return value != null && (HEALTH_BANDS as string[]).includes(value) ? (value as HealthScoreBand) : null;
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const entitled = await isIntelligenceEntitled(db, accountId);
  if (!entitled) return { entitled: false as const };

  const params = new URL(request.url).searchParams;
  const search = params.get("q")?.trim() || null;
  const tier = params.get("tier") || null;
  const healthBand = parseHealthBand(params.get("band"));
  const sort: CustomerDirectorySort = params.get("sort") === "mrr_desc" ? "mrr_desc" : "health_asc";
  const pageParam = Number(params.get("page") ?? "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  const [result, tiers] = await Promise.all([
    listCustomerDirectory(db, accountId, { search, tier, healthBand, sort, page }),
    listCustomerTiers(db, accountId),
  ]);

  return {
    entitled: true as const,
    // Only what the page shows reaches the browser: no email, and the two
    // signals as booleans rather than their JSON (recovery ids, dispute
    // counts). The shared query keeps both for its other caller (the MCP
    // tool, which masks them).
    result: {
      ...result,
      customers: result.customers.map((c) => ({
        stripeCustomerId: c.stripeCustomerId,
        customerName: c.customerName,
        currentPlanTier: c.currentPlanTier,
        mrrContributionCents: c.mrrContributionCents,
        currency: c.currency,
        healthScore: c.healthScore,
        lastSeenAt: c.lastSeenAt,
        hasActiveRecovery: hasActiveRecoverySignal(c.recoverySignals),
        hasDisputeHistory: hasDisputeHistorySignal(c.disputeSignals),
      })),
    },
    tiers,
    filters: { search: search ?? "", tier: tier ?? "", healthBand: healthBand ?? "", sort },
    // Already resolved on every authenticated request, so the H1 costs no
    // extra query (app/lib/auth/account.ts Membership).
    accountName: auth.membership.accountName,
    nowMs: Date.now(),
  };
}

/** Preserve every current filter param, only overriding `page`, so paging
 *  never drops a filter. */
function pageHref(filters: Filters, page: number): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.tier) params.set("tier", filters.tier);
  if (filters.healthBand) params.set("band", filters.healthBand);
  if (filters.sort !== "health_asc") params.set("sort", filters.sort);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/intelligence/customers?${qs}` : "/intelligence/customers";
}

type Filters = { search: string; tier: string; healthBand: string; sort: CustomerDirectorySort };

/** True when any filter narrows the list, so an empty list means "nothing
 *  matched" rather than "nothing yet". The sort narrows nothing. */
function isFiltered(filters: Filters): boolean {
  return Boolean(filters.search || filters.tier || filters.healthBand);
}

export default function IntelligenceCustomersPage({ loaderData }: Route.ComponentProps) {
  if (!loaderData.entitled) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-title font-medium text-text">Customers</h1>
        <IntelligenceUpsell />
      </div>
    );
  }

  const { result, tiers, filters, accountName, nowMs } = loaderData;
  const now = new Date(nowMs);
  const filtered = isFiltered(filters);
  // Recova's empty card stands in for the table only when the account has no
  // customers at all. Under a filter the bar stays, so the filter can be
  // changed, and the table's place says nothing matched.
  const noData = result.totalCount === 0 && !filtered;

  // Recova's H1 is `{accountName} customers` (page.tsx:71). Recova computes
  // `membership.account.name ?? 'Customers'` first, so an account with no name
  // gets "Customers customers", a defect not copied (ruling 39): with no name
  // the heading is "Customers".
  const heading = accountName ? `${accountName} customers` : "Customers";

  // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-8 md:py-10. The shell
  // owns the page's one <main> (ruling 146), so this is a plain wrapper.
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 md:px-8 md:py-10">
      <div className="mb-6">
        <PageHead
          title={heading}
          lead={
            filters.sort === "mrr_desc"
              ? "Sorted by MRR, highest first."
              : "Sorted by health score, lowest first. Customers worth attention surface at the top."
          }
        />
        {/* Recova's count line, only when there are customers. /intelligence/
            churn has no equivalent, so it sits just below the head rather than
            in PageHead's actions slot, which is for controls. "1 customer" is
            singular; Recova's "1 customers" is not copied. */}
        {result.totalCount > 0 ? (
          <p className="mt-2 mb-0 font-mono text-label text-text-tertiary">
            {result.totalCount} {result.totalCount === 1 ? "customer" : "customers"} ·{" "}
            {formatMoney(result.totalMrrCents, "usd")}/mo total MRR
          </p>
        ) : null}
      </div>

      {noData ? (
        // Recova's empty card is a heading and a line. Capsomer's Empty puts
        // its title in a <p>, which would demote Recova's h2, so the nearest
        // Capsomer part that keeps the heading is a Panel, as on /intelligence/
        // churn (gap named in the J30 notes).
        <Panel title="No customer data yet">
          <p className="m-0 text-label text-text-tertiary">
            Intelligence populates as customers transact in your Stripe account. Check back as data accumulates.
          </p>
        </Panel>
      ) : (
        <>
          <div className="mb-6">
            <FilterBar filters={filters} tiers={tiers} />
          </div>

          {result.customers.length === 0 ? (
            <Empty kind="no-match" title="No customers match these filters.">
              Change or clear a filter to see more customers.
            </Empty>
          ) : (
            <div className="cap-panel">
              <div className="cap-panel-body" data-flush="">
                <div className="cap-table-wrap" data-cap="table" role="region" aria-label="Customers" tabIndex={0}>
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
                        <th scope="col">Last seen</th>
                        <th scope="col">Signals</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.customers.map((c) => {
                        const pill = planTierPill(c.currentPlanTier);
                        return (
                          <tr key={c.stripeCustomerId}>
                            <th scope="row">
                              {/* A plain link on the name, as Recova's is: not
                                  Capsomer's stretched row link, which would lie
                                  over the Signals tooltips and the Stripe id.
                                  min-h-6 keeps a 24px target. */}
                              <Link
                                className="inline-flex min-h-6 items-center font-semibold text-text no-underline hover:text-accent-hover"
                                to={`/intelligence/customers/${c.stripeCustomerId}`}
                              >
                                {c.customerName ?? "(unnamed)"}
                              </Link>
                              {/* Recova's second line under the name: the Stripe
                                  id, micro and mono. */}
                              <span className="block font-mono text-micro text-text-subtle">{c.stripeCustomerId}</span>
                            </th>
                            <td>
                              {/* Capsomer's pill markup rather than its Pill
                                  component, which adds a status glyph to any
                                  toned pill; a plan is not a status. */}
                              <span className="cap-pill" data-tone={pill.tone} data-variant="outline">
                                {pill.label}
                              </span>
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
                              <span className="font-mono text-text-tertiary">
                                {formatRelativeLastSeen(c.lastSeenAt, now)}
                              </span>
                            </td>
                            <td>
                              {/* Recova's two signals under Recova's names. An
                                  empty cell is blank, as Recova's is. */}
                              <div className="flex items-center gap-2">
                                {c.hasActiveRecovery ? (
                                  <span
                                    role="img"
                                    className="h-2 w-2 shrink-0 rounded-full bg-red"
                                    title="Active recovery"
                                    aria-label="Active recovery"
                                  />
                                ) : null}
                                {c.hasDisputeHistory ? (
                                  <Scale
                                    width={14}
                                    height={14}
                                    strokeWidth={1.75}
                                    className="shrink-0 text-text-tertiary"
                                    role="img"
                                    aria-label="Dispute history"
                                  >
                                    <title>Dispute history</title>
                                  </Scale>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {result.totalPages > 1 ? <Pager filters={filters} page={result.page} totalPages={result.totalPages} /> : null}
    </div>
  );
}

/** The approved filter bar (APPROVED-DIFFERENCES, 2026-08-28) on Capsomer's
 *  field labels, input, native selects and primary button, in a body-only
 *  panel. A plain GET form, so it works with no script. */
function FilterBar({ filters, tiers }: { filters: Filters; tiers: string[] }) {
  return (
    <Form method="get" className="cap-panel">
      <div className="cap-panel-body">
        {/* The bar's layout and its text at the label size (RULES 5.2) on a
            wrapper of the page's own: Capsomer's field label has no size of its
            own, and its base.css is not loaded in the app. */}
        <div className="flex flex-wrap items-end gap-3 text-label">
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="customers-q">
              Name or email
            </label>
            <input
              className="cap-input"
              id="customers-q"
              type="text"
              name="q"
              defaultValue={filters.search}
              placeholder="Search"
            />
          </div>
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="customers-tier">
              Plan
            </label>
            <div className="cap-select-wrap">
              <select className="cap-select" id="customers-tier" name="tier" defaultValue={filters.tier}>
                <option value="">All plans</option>
                {tiers.map((t) => (
                  <option key={t} value={t}>
                    {capitalizeTier(t)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="customers-band">
              Health
            </label>
            <div className="cap-select-wrap">
              <select className="cap-select" id="customers-band" name="band" defaultValue={filters.healthBand}>
                <option value="">All health bands</option>
                {HEALTH_BANDS.map((b) => (
                  <option key={b} value={b}>
                    {HEALTH_BAND_LABEL[b]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="cap-field">
            <label className="cap-field-label" htmlFor="customers-sort">
              Sort
            </label>
            <div className="cap-select-wrap">
              <select className="cap-select" id="customers-sort" name="sort" defaultValue={filters.sort}>
                <option value="health_asc">Health, lowest first</option>
                <option value="mrr_desc">MRR, highest first</option>
              </select>
            </div>
          </div>
          <Button type="submit" variant="primary">
            Filter
          </Button>
        </div>
      </div>
    </Form>
  );
}

/** Recova's pager: "Page N of M" on the left, then Previous and Next together
 *  on the right, each shown only when it leads somewhere. Capsomer's pagination
 *  markup with its status line and its two ends; Capsomer's chevrons stand in
 *  for Recova's arrows. Its React Pagination adds page numbers and always shows
 *  both ends, which Recova's page does not (gap named in the J30 notes). */
function Pager({ filters, page, totalPages }: { filters: Filters; page: number; totalPages: number }) {
  return (
    // Recova's mt-4 sits on a wrapper so the Capsomer nav carries no Foxhound class.
    <div className="mt-4">
      <nav className="cap-pagination" aria-label="Customer pages">
        <p className="cap-pagination-status">
          Page {page} of {totalPages}
        </p>
        <ul className="cap-pagination-list">
          {page > 1 ? (
            <li>
              <Link className="cap-page" data-kind="prev" to={pageHref(filters, page - 1)} rel="prev">
                Previous
              </Link>
            </li>
          ) : null}
          {page < totalPages ? (
            <li>
              <Link className="cap-page" data-kind="next" to={pageHref(filters, page + 1)} rel="next">
                Next
              </Link>
            </li>
          ) : null}
        </ul>
      </nav>
    </div>
  );
}
