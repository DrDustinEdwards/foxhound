// Query-string construction for the /recovery/payments filter set.
//
// Extracted from the route so it can be tested directly. It used to be a
// route-private helper that silently dropped the amount range: the status
// pills, the pagination links, and the CSV export link were all built from it,
// so engaging the amount slider and then clicking any of them widened the
// result set back out without telling the visitor. The export was the worst
// case, since the downloaded file disagreed with the list on screen.

import type { AmountBounds } from "./queries.server";
import type { PaymentTimeRange } from "./time-range";

/** The filter state a payments URL round-trips. Mirrors the loader's own
 *  `filters` return value. */
export interface PaymentFilterState {
  search: string;
  status: string;
  declineCategory: string;
  time: PaymentTimeRange;
  sort: string;
  pageSize: number | "all";
  amountMinCents: number;
  amountMaxCents: number;
}

export interface BuildPaymentParamsOptions {
  /** The account's absolute amount bounds. A handle resting on its own bound is
   *  not a filter, so the corresponding param is omitted; without this the
   *  links would carry a redundant full-width range on every navigation. */
  bounds: AmountBounds;
  /** The loader's default page size, omitted from the URL when unchanged. */
  defaultPageSize: number | "all";
  /** Set a param to a new value, or clear it by passing an empty string. */
  overrides?: Partial<Record<string, string>>;
}

/**
 * Build the search params representing `filters`, preserving every dimension
 * including the amount range.
 */
export function buildPaymentParams(
  filters: PaymentFilterState,
  { bounds, defaultPageSize, overrides = {} }: BuildPaymentParamsOptions,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.status) params.set("status", filters.status);
  if (filters.declineCategory) params.set("category", filters.declineCategory);
  if (filters.time !== "all") params.set("time", filters.time);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (filters.pageSize !== defaultPageSize) params.set("perPage", String(filters.pageSize));
  if (filters.amountMinCents > bounds.minCents) params.set("amountMin", String(filters.amountMinCents));
  if (filters.amountMaxCents < bounds.maxCents) params.set("amountMax", String(filters.amountMaxCents));
  for (const [key, value] of Object.entries(overrides)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  return params;
}

/** `path` with `params` appended, or bare `path` when there are none. */
export function withParams(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
