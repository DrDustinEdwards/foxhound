import { useRef } from "react";
import { Form, Link, useNavigate } from "react-router";

import { Badge } from "~/components/badge";
import { DualRangeSlider } from "~/components/dual-range-slider";
import { StatCard } from "~/components/stat-card";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatMoney } from "~/lib/money-format";
import { formatRelativeTime } from "~/lib/dashboard/recovery-window";
import {
  DECLINE_CATEGORY_LABELS,
  FAILED_PAYMENT_STATUS_LABELS,
  failedPaymentStatusTone,
} from "~/lib/recovery/labels";
import {
  getAmountBounds,
  getGlobalPaymentStatusCounts,
  listFilteredFailedPayments,
  listPaymentSummaryRows,
  listStepsForFailedPayments,
  countFailuresByCustomer,
  tallyStatusCounts,
} from "~/lib/recovery/queries.server";
import type { AmountBounds, FailedPaymentPageSize, FailedPaymentSort } from "~/lib/recovery/queries.server";
import { buildPaymentParams, withParams } from "~/lib/recovery/payment-filters";
import { nextRovingIndex } from "~/lib/a11y/roving-index";
import { priorFailureCount } from "~/lib/recovery/prior-failures";
import { summarizeSequence } from "~/lib/recovery/sequence-summary";
import { isPaymentTimeRange, resolvePaymentTimeRangeCutoff, type PaymentTimeRange } from "~/lib/recovery/time-range";

import type { Route } from "./+types/index";

// /recovery/payments (TASK-foxhound-recovery-surface-parity.md Phase 3):
// header stats line + five summary cards, search across name/email/plan,
// status pills with counts, time/category/sort dropdowns, a dual-handle
// amount range, rows-per-page, pagination with a result count, and CSV
// export. Every filter lives in the loader's search params; nothing here
// re-filters an already-fetched page client-side.

export function meta() {
  return [{ title: "Payments - Foxhound" }];
}

const DECLINE_CATEGORY_OPTIONS = Object.keys(DECLINE_CATEGORY_LABELS) as (keyof typeof DECLINE_CATEGORY_LABELS)[];
const PAGE_SIZE_OPTIONS: FailedPaymentPageSize[] = [10, 25, 50, 100, "all"];
// Duplicated from queries.server.ts's DEFAULT_PAYMENT_PAGE_SIZE rather than
// imported: this constant is used by buildParams, which the client component
// calls, and a .server.ts value import there breaks the client bundle split
// (React Router only strips server-only code from loader/action/etc, not
// from a route's other exports).
const DEFAULT_PAGE_SIZE: FailedPaymentPageSize = 50;

function parseSort(value: string | null): FailedPaymentSort {
  return value === "oldest" || value === "amount_desc" || value === "amount_asc" ? value : "newest";
}

function parseTimeRange(value: string | null): PaymentTimeRange {
  return value && isPaymentTimeRange(value) ? value : "all";
}

function parsePageSize(value: string | null): FailedPaymentPageSize {
  if (value === "all") return "all";
  const n = Number(value);
  return (PAGE_SIZE_OPTIONS as (number | "all")[]).includes(n) ? (n as FailedPaymentPageSize) : DEFAULT_PAGE_SIZE;
}

function parseAmountParam(value: string | null, floorCents: number, ceilingCents: number): number | null {
  if (!value) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, floorCents), ceilingCents);
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;
  const nowMs = Date.now();

  const params = new URL(request.url).searchParams;
  const search = params.get("q")?.trim() || null;
  const status = params.get("status") || null;
  const declineCategory = params.get("category") || null;
  const sort = parseSort(params.get("sort"));
  const time = parseTimeRange(params.get("time"));
  const pageParam = Number(params.get("page") ?? "1");
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;
  const pageSize = parsePageSize(params.get("perPage"));

  const bounds = await getAmountBounds(db, accountId);
  const amountMinParsed = parseAmountParam(params.get("amountMin"), bounds.minCents, bounds.maxCents);
  const amountMaxParsed = parseAmountParam(params.get("amountMax"), bounds.minCents, bounds.maxCents);
  // Only push a bound into the query when it actually narrows the range;
  // a slider left at its own default extremes is "no filter", not a filter
  // that happens to equal the bounds.
  const amountMinCents = amountMinParsed !== null && amountMinParsed > bounds.minCents ? amountMinParsed : null;
  const amountMaxCents = amountMaxParsed !== null && amountMaxParsed < bounds.maxCents ? amountMaxParsed : null;
  const detectedAfterMs = resolvePaymentTimeRangeCutoff(time, nowMs);

  const filterInput = { search, declineCategory, detectedAfterMs, amountMinCents, amountMaxCents };

  const [result, globalCounts, summaryRows] = await Promise.all([
    listFilteredFailedPayments(db, accountId, { ...filterInput, status, sort, page, pageSize }),
    getGlobalPaymentStatusCounts(db, accountId),
    listPaymentSummaryRows(db, accountId, filterInput),
  ]);

  const [previousFailureCounts, stepRows] = await Promise.all([
    countFailuresByCustomer(db, accountId, [...new Set(result.payments.map((p) => p.stripeCustomerId))]),
    listStepsForFailedPayments(db, accountId, result.payments.map((p) => p.id)),
  ]);

  const stepSummaries: Record<string, { completedCount: number; totalCount: number }> = {};
  for (const payment of result.payments) {
    const ownSteps = stepRows.filter((s) => s.failedPaymentId === payment.id);
    stepSummaries[payment.id] = summarizeSequence(ownSteps);
  }

  const pillCounts = tallyStatusCounts(summaryRows.map((r) => r.status));
  const headerRows = status ? summaryRows.filter((r) => r.status === status) : summaryRows;
  const atRiskCents = headerRows.filter((r) => r.status === "active").reduce((s, r) => s + r.amountCents, 0);
  const recoveredCents = headerRows.filter((r) => r.status === "recovered").reduce((s, r) => s + r.amountCents, 0);
  const recoveredRowCount = headerRows.filter((r) => r.status === "recovered").length;
  const headerRecoveryRatePct = headerRows.length > 0 ? Math.round((recoveredRowCount / headerRows.length) * 100) : null;
  const globalRecoveryRatePct = globalCounts.all > 0 ? Math.round((globalCounts.recovered / globalCounts.all) * 100) : null;

  return {
    result,
    globalCounts,
    globalRecoveryRatePct,
    pillCounts,
    atRiskCents,
    recoveredCents,
    headerRecoveryRatePct,
    bounds,
    previousFailureCounts,
    stepSummaries,
    nowMs,
    filters: {
      search: search ?? "",
      status: status ?? "",
      declineCategory: declineCategory ?? "",
      time,
      sort,
      pageSize,
      amountMinCents: amountMinParsed ?? bounds.minCents,
      amountMaxCents: amountMaxParsed ?? bounds.maxCents,
    },
  };
}

interface Filters {
  search: string;
  status: string;
  declineCategory: string;
  time: PaymentTimeRange;
  sort: FailedPaymentSort;
  pageSize: FailedPaymentPageSize;
  amountMinCents: number;
  amountMaxCents: number;
}

function buildParams(
  filters: Filters,
  bounds: AmountBounds,
  overrides: Partial<Record<string, string>> = {},
): URLSearchParams {
  return buildPaymentParams(filters, { bounds, defaultPageSize: DEFAULT_PAGE_SIZE, overrides });
}

function statusPillHref(filters: Filters, bounds: AmountBounds, status: string): string {
  return withParams("/recovery/payments", buildParams(filters, bounds, { status }));
}

function pageHref(filters: Filters, bounds: AmountBounds, page: number): string {
  const params = buildParams(filters, bounds);
  if (page > 1) params.set("page", String(page));
  return withParams("/recovery/payments", params);
}

function exportHref(filters: Filters, bounds: AmountBounds): string {
  return withParams("/recovery/payments/export.csv", buildParams(filters, bounds));
}

const STATUS_PILLS = [
  { value: "", label: "All" },
  { value: "active", label: "In recovery" },
  { value: "recovered", label: "Recovered" },
  { value: "failed_unrecovered", label: "Not recovered" },
] as const;

interface PillCounts {
  all: number;
  active: number;
  recovered: number;
  failedUnrecovered: number;
}

/**
 * Legacy's status filter is a `role="radiogroup"` with a roving tabindex and
 * full arrow-key handling (app/(app)/recovery/payments/components/
 * PaymentsFilters.tsx). Foxhound shipped four plain links: it RENDERS the same
 * and ANNOUNCES nothing, so a screen reader hears four unrelated links rather
 * than one four-option control, and a keyboard user tabs through every option
 * instead of arrowing within a single stop.
 *
 * Third and last of ruling 189's accessibility unit, after 146's main landmark
 * and 197's <h2> conversion. Legacy ACTIVATES on arrow rather than merely
 * moving focus, so arrowing both focuses and applies the filter; that is ported
 * rather than approximated. Home and End jump to first and last, as legacy does.
 *
 * The links stay links because Foxhound's filter state lives in the URL, not in
 * client state. Every className below is byte-identical to the pre-port markup:
 * this changes semantics only, per 197's standard while 187's type freeze holds.
 */
function StatusPills({
  filters,
  bounds,
  pillCounts,
}: {
  filters: Filters;
  bounds: AmountBounds;
  pillCounts: PillCounts;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  function countFor(value: string): number {
    if (value === "") return pillCounts.all;
    if (value === "active") return pillCounts.active;
    if (value === "recovered") return pillCounts.recovered;
    return pillCounts.failedUnrecovered;
  }

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    // Index arithmetic lives in ~/lib/a11y/roving-index so it is testable;
    // vitest runs environment: "node" with no DOM (ruling 209's residue).
    const next = nextRovingIndex(event.key, index, STATUS_PILLS.length);
    if (next === null) return;
    event.preventDefault();
    groupRef.current?.querySelectorAll<HTMLAnchorElement>('[role="radio"]')[next]?.focus();
    navigate(statusPillHref(filters, bounds, STATUS_PILLS[next].value));
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Filter by status"
      className="mt-6 flex flex-wrap gap-2"
    >
      {STATUS_PILLS.map((pill, index) => {
        const active = filters.status === pill.value;
        return (
          <Link
            key={pill.value}
            to={statusPillHref(filters, bounds, pill.value)}
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`rounded-full border px-3 py-1 text-label ${
              active ? "border-amber bg-amber text-on-amber" : "border-border text-text-tertiary hover:border-border-i"
            }`}
          >
            {pill.label} <span className="font-mono text-micro">{countFor(pill.value)}</span>
          </Link>
        );
      })}
    </div>
  );
}

export default function RecoveryPayments({ loaderData }: Route.ComponentProps) {
  const {
    result,
    globalCounts,
    globalRecoveryRatePct,
    pillCounts,
    atRiskCents,
    recoveredCents,
    headerRecoveryRatePct,
    bounds,
    previousFailureCounts,
    stepSummaries,
    nowMs,
    filters,
  } = loaderData;

  return (
    <div className="mx-auto max-w-[1280px] px-4 md:px-8 py-10">
      {/* Ruling 147 f1-f3, legacy app/(app)/recovery/payments/PaymentsClient.tsx:
      max-w-[1280px] mx-auto px-4 md:px-8 py-10. Vertical is a flat py-10 here,
      NOT console's py-8 md:py-10: legacy's rhythm varies per page and the set
      is not uniform. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-title font-medium text-text">Payments</h1>
        <Link
          to={exportHref(filters, bounds)}
          className="rounded-md border border-border px-3 py-1.5 text-label text-text-secondary hover:border-border-i"
        >
          Export CSV
        </Link>
      </div>

      <p className="mt-2 text-label text-text-tertiary">
        {formatMoney(atRiskCents, "usd")} at risk · {formatMoney(recoveredCents, "usd")} recovered
        {headerRecoveryRatePct !== null ? ` · ${headerRecoveryRatePct}% recovery rate` : ""}
        {" for the current filters"}
      </p>

      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Total payments" value={String(globalCounts.all)} subtext="all filters" />
        <StatCard label="Active" value={String(globalCounts.active)} />
        <StatCard label="Recovered" value={String(globalCounts.recovered)} />
        <StatCard label="Not recovered" value={String(globalCounts.failedUnrecovered)} />
        <StatCard
          label="Recovery rate"
          value={globalRecoveryRatePct === null ? "-" : `${globalRecoveryRatePct}%`}
        />
      </section>

      <StatusPills filters={filters} bounds={bounds} pillCounts={pillCounts} />

      <Form method="get" className="mt-4 flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
        <input type="hidden" name="status" value={filters.status} />
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Name, email, or plan</span>
            <input
              type="text"
              name="q"
              defaultValue={filters.search}
              placeholder="Search"
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-amber"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Time</span>
            <select
              name="time"
              defaultValue={filters.time}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-amber"
            >
              <option value="all">All time</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Decline</span>
            <select
              name="category"
              defaultValue={filters.declineCategory}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-amber"
            >
              <option value="">All declines</option>
              {DECLINE_CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {DECLINE_CATEGORY_LABELS[c]}
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
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="amount_desc">Amount, highest first</option>
              <option value="amount_asc">Amount, lowest first</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Rows per page</span>
            <select
              name="perPage"
              defaultValue={String(filters.pageSize)}
              className="rounded-md border border-border bg-surface2 px-3 py-2 text-body text-text focus-visible:border-amber"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size === "all" ? "All" : size}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-md bg-amber px-4 py-2 text-body font-medium text-on-amber">
            Filter
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between font-mono text-micro text-text-tertiary">
            <span>{formatMoney(filters.amountMinCents, "usd")}</span>
            <span>Amount range</span>
            <span>{formatMoney(filters.amountMaxCents, "usd")}</span>
          </div>
          <DualRangeSlider
            min={bounds.minCents}
            max={bounds.maxCents}
            valueMin={filters.amountMinCents}
            valueMax={filters.amountMaxCents}
            minName="amountMin"
            maxName="amountMax"
          />
        </div>
      </Form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-label">
          <thead>
            <tr className="border-b border-border text-micro uppercase tracking-wide text-text-tertiary">
              <th className="px-4 py-3 font-normal">Customer</th>
              <th className="px-4 py-3 font-normal">Amount</th>
              <th className="px-4 py-3 font-normal">Decline</th>
              <th className="px-4 py-3 font-normal">Steps</th>
              <th className="px-4 py-3 font-normal">Status</th>
              <th className="px-4 py-3 font-normal">Detected</th>
            </tr>
          </thead>
          <tbody>
            {result.payments.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-body text-text-tertiary">
                  {filters.search || filters.status || filters.declineCategory
                    ? "No payments match these filters."
                    : "No failed payments yet. Foxhound will list every failed payment it detects here."}
                </td>
              </tr>
            ) : (
              result.payments.map((p) => {
                const priorCount = priorFailureCount(previousFailureCounts[p.stripeCustomerId]);
                const steps = stepSummaries[p.id];
                return (
                  <tr key={p.id} className="border-b border-border-sub last:border-0">
                    <td className="px-4 py-3">
                      <Link to={`/recovery/payments/${p.id}`} className="text-text hover:text-amber">
                        {p.customerName ?? p.customerEmail}
                      </Link>
                      {priorCount > 0 ? (
                        <span className="ml-2 text-micro text-text-subtle">+{priorCount} prior</span>
                      ) : null}
                      <p className="text-micro text-text-subtle">{p.customerEmail}</p>
                      {p.planName ? <p className="text-micro text-text-subtle">{p.planName}</p> : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-text">{formatMoney(p.amountCents, p.currency)}</td>
                    <td className="px-4 py-3 text-text-tertiary">
                      {DECLINE_CATEGORY_LABELS[p.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS] ??
                        p.declineCategory}
                      {p.declineCode ? (
                        <span className="ml-2 font-mono text-micro text-text-subtle">{p.declineCode}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-text-tertiary">
                      {steps ? `${steps.completedCount} of ${steps.totalCount}` : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={failedPaymentStatusTone(p.status)}>
                        {FAILED_PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">
                      <p>{formatRelativeTime(p.detectedAt, nowMs)}</p>
                      <p className="text-micro text-text-subtle">{p.detectedAt.toLocaleDateString()}</p>
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
            <Link to={pageHref(filters, bounds, result.page - 1)} className="text-amber-text hover:underline">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="font-mono text-micro">
            Page {result.page} of {result.totalPages} · {result.totalCount} result
            {result.totalCount === 1 ? "" : "s"}
          </span>
          {result.page < result.totalPages ? (
            <Link to={pageHref(filters, bounds, result.page + 1)} className="text-amber-text hover:underline">
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : (
        <p className="mt-4 text-right font-mono text-micro text-text-tertiary">
          {result.totalCount} result{result.totalCount === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}
