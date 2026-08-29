import { Scale } from "lucide-react";
import { Form, Link } from "react-router";

import { Badge } from "~/components/badge";
import { IntelligenceUpsell } from "~/components/intelligence-upsell";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import {
  capitalizeTier,
  formatRelativeLastSeen,
  hasActiveRecoverySignal,
  hasDisputeHistorySignal,
} from "~/lib/intelligence/customer-directory";
import { healthScoreClassName } from "~/lib/intelligence/health-band";
import {
  isIntelligenceEntitled,
  listCustomerDirectory,
  listCustomerTiers,
  type CustomerDirectorySort,
} from "~/lib/intelligence/views.server";
import type { HealthScoreBand } from "~/lib/intelligence/health-band";
import { formatMoney } from "~/lib/money-format";

import type { Route } from "./+types/customers";

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
    result,
    tiers,
    filters: { search: search ?? "", tier: tier ?? "", healthBand: healthBand ?? "", sort },
    // Already resolved on every authenticated request, so the H1 costs no
    // extra query (app/lib/auth/account.ts Membership).
    accountName: auth.membership.accountName,
    nowMs: Date.now(),
  };
}

/** Preserve every current filter param, only overriding `page` - used by the
 *  Previous/Next links so paging never drops a filter. */
function pageHref(filters: { search: string; tier: string; healthBand: string; sort: CustomerDirectorySort }, page: number): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.tier) params.set("tier", filters.tier);
  if (filters.healthBand) params.set("band", filters.healthBand);
  if (filters.sort !== "health_asc") params.set("sort", filters.sort);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/intelligence/customers?${qs}` : "/intelligence/customers";
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

  // Legacy's H1 is `{accountName} customers`
  // (app/(app)/intelligence/customers/page.tsx:74), which reads as the account's
  // own book of customers rather than a generic page label. It matters more here
  // than it did in legacy: multi-account shipped (core.md phases (a) to (e)), so
  // a merchant holding several accounts can now be looking at any of them, and
  // the H1 is what says which.
  //
  // THE NULL BRANCH IS NOT LEGACY'S AND IS FLAGGED. Legacy computes
  // `membership.account.name ?? 'Customers'` and then renders "{that} customers",
  // so an account with no name gets the H1 "Customers customers". That is a
  // legacy defect in ruling 39's class rather than a treatment to port, and
  // fix direction is a ruling, so it is raised rather than reproduced: with no
  // name the heading is just "Customers", which is what the page said before
  // this change.
  const heading = accountName ? `${accountName} customers` : "Customers";

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/* Type stays Foxhound's: 179/187 freeze the type scale in BOTH
            directions, and the 394 walk already recorded legacy's 24px/600
            against this 20px/500 as FROZEN. Only the words change. */}
        <h1 className="text-title font-medium text-text">{heading}</h1>
        <p className="font-mono text-label text-text-tertiary">
          {result.totalCount} {result.totalCount === 1 ? "customer" : "customers"} ·{" "}
          {formatMoney(result.totalMrrCents, "usd")}/mo
        </p>
      </div>
      <p className="mt-1 text-label text-text-tertiary">
        {filters.sort === "mrr_desc" ? "Sorted by MRR, highest first." : "Sorted by health score, lowest first."}
      </p>

      <Form method="get" className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Name or email</span>
          <input
            type="text"
            name="q"
            defaultValue={filters.search}
            placeholder="Search"
            className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-amber"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Plan</span>
          <select
            name="tier"
            defaultValue={filters.tier}
            className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-amber"
          >
            <option value="">All plans</option>
            {tiers.map((t) => (
              <option key={t} value={t}>
                {capitalizeTier(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Health</span>
          <select
            name="band"
            defaultValue={filters.healthBand}
            className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-amber"
          >
            <option value="">All health bands</option>
            {HEALTH_BANDS.map((b) => (
              <option key={b} value={b}>
                {HEALTH_BAND_LABEL[b]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Sort</span>
          <select
            name="sort"
            defaultValue={filters.sort}
            className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-amber"
          >
            <option value="health_asc">Health, lowest first</option>
            <option value="mrr_desc">MRR, highest first</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-amber px-4 py-2 text-body font-medium text-on-amber"
        >
          Filter
        </button>
      </Form>

      <div className="mt-6 overflow-x-auto rounded-[12px] border border-border bg-surface">
        <table className="w-full text-left text-label">
          <thead>
            <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
              <th className="px-4 py-3 font-normal">Customer</th>
              <th className="px-4 py-3 font-normal">Plan</th>
              <th className="px-4 py-3 text-right font-normal">MRR</th>
              <th className="px-4 py-3 text-right font-normal">Health</th>
              <th className="px-4 py-3 font-normal">Last seen</th>
              <th className="px-4 py-3 font-normal">Signals</th>
            </tr>
          </thead>
          <tbody>
            {result.customers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-body text-text-tertiary">
                  No customers match these filters.
                </td>
              </tr>
            ) : (
              result.customers.map((c) => {
                const activeRecovery = hasActiveRecoverySignal(c.recoverySignals);
                const disputeHistory = hasDisputeHistorySignal(c.disputeSignals);
                return (
                  <tr key={c.stripeCustomerId} className="border-b border-border-sub last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        to={`/intelligence/customers/${c.stripeCustomerId}`}
                        className="text-text hover:text-amber"
                      >
                        {c.customerName ?? c.customerEmail ?? c.stripeCustomerId}
                      </Link>
                      <p className="font-mono text-micro text-text-subtle">{c.stripeCustomerId}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone="neutral">{capitalizeTier(c.currentPlanTier)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-text">
                      {c.mrrContributionCents > 0 ? formatMoney(c.mrrContributionCents, c.currency) : "-"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {c.healthScore == null ? (
                        <span className="font-mono text-text-tertiary">-</span>
                      ) : (
                        <span className={`font-mono font-semibold ${healthScoreClassName(c.healthScore)}`}>
                          {c.healthScore}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">{formatRelativeLastSeen(c.lastSeenAt, now)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {activeRecovery ? (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-red"
                            title="Active recovery in progress"
                            aria-label="Active recovery in progress"
                          />
                        ) : null}
                        {disputeHistory ? (
                          <Scale
                            width={14}
                            height={14}
                            strokeWidth={1.75}
                            className="shrink-0 text-text-tertiary"
                            aria-label="Has dispute history"
                          >
                            <title>Has dispute history</title>
                          </Scale>
                        ) : null}
                        {!activeRecovery && !disputeHistory ? <span className="text-text-tertiary">-</span> : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {result.totalPages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-label text-text-tertiary">
          {result.page > 1 ? (
            <Link to={pageHref(filters, result.page - 1)} className="text-amber-text hover:underline">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="font-mono text-micro">
            Page {result.page} of {result.totalPages}
          </span>
          {result.page < result.totalPages ? (
            <Link to={pageHref(filters, result.page + 1)} className="text-amber-text hover:underline">
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </div>
  );
}
