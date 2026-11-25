import { clearedHref, withParams } from "capsomer/react/filter-bar";
import type {
  AmountBounds,
  FailedPaymentPageSize,
  FailedPaymentSort,
} from "~/lib/recovery/queries.server";
import { buildPaymentParams } from "~/lib/recovery/payment-filters";
import { PAYMENTS_DEFAULT_PAGE_SIZE } from "~/lib/recovery/payments-list";
import type { PaymentTimeRange } from "~/lib/recovery/time-range";

export interface Filters {
  search: string;
  status: string;
  declineCategory: string;
  time: PaymentTimeRange;
  sort: FailedPaymentSort;
  pageSize: FailedPaymentPageSize;
  amountMinCents: number;
  amountMaxCents: number;
}

export const BASE = "/recovery/payments";

export function hrefWith(
  filters: Filters,
  bounds: AmountBounds,
  overrides: Partial<Record<string, string>> = {},
): string {
  return withParams(
    BASE,
    buildPaymentParams(filters, { bounds, defaultPageSize: PAYMENTS_DEFAULT_PAGE_SIZE, overrides }),
  );
}

export function pageHref(filters: Filters, bounds: AmountBounds, page: number): string {
  return hrefWith(filters, bounds, { page: page > 1 ? String(page) : "" });
}

/** Export CSV writes the rows on screen, so the link carries this page and this page size as well as the filters. */
export function exportHref(filters: Filters, bounds: AmountBounds, page: number): string {
  return withParams(
    `${BASE}/export.csv`,
    buildPaymentParams(filters, {
      bounds,
      defaultPageSize: PAYMENTS_DEFAULT_PAGE_SIZE,
      overrides: { page: String(page), perPage: String(filters.pageSize) },
    }),
  );
}

export function paramsFor(filters: Filters, bounds: AmountBounds) {
  return buildPaymentParams(filters, { bounds, defaultPageSize: PAYMENTS_DEFAULT_PAGE_SIZE });
}

/** Clear filters keeps the sort and the page size and drops the rest. The currency is which amounts the range shows, not a filter, so it stays too. */
export function clearHref(filters: Filters, bounds: AmountBounds): string {
  return clearedHref(BASE, paramsFor(filters, bounds), ["sort", "perPage", "currency"]);
}

export const STATUS_PILLS = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "recovered", label: "Recovered" },
  { value: "cancelled", label: "Canceled" },
  { value: "failed_unrecovered", label: "Failed" },
] as const;

export interface PillCounts {
  all: number;
  active: number;
  recovered: number;
  failedUnrecovered: number;
  cancelled: number;
}

export function countFor(pillCounts: PillCounts, value: string): number {
  if (value === "") return pillCounts.all;
  if (value === "active") return pillCounts.active;
  if (value === "recovered") return pillCounts.recovered;
  if (value === "cancelled") return pillCounts.cancelled;
  return pillCounts.failedUnrecovered;
}

export const DATE_RANGES: { value: PaymentTimeRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export const SORTS: { value: FailedPaymentSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "amount_desc", label: "Highest amount" },
  { value: "amount_asc", label: "Lowest amount" },
];
