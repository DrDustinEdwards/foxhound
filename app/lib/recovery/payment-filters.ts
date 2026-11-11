// Query-string construction for the /recovery/payments filter set.
//
// Extracted from the route so it can be tested directly. It used to be a
// route-private helper that silently dropped the amount range: the status
// pills, the pagination links, and the CSV export link were all built from it,
// so engaging the amount slider and then clicking any of them widened the
// result set back out without telling the visitor. The export was the worst
// case, since the downloaded file disagreed with the list on screen.

import type { Params } from "capsomer/behavior/filter-bar";

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
 * The query params representing `filters`, preserving every dimension including
 * the amount range, for Capsomer's `withParams`, which leaves out an empty or
 * null value. A value at its default (all time, newest first, the default page
 * size) is null here, so one view has one address.
 */
export function buildPaymentParams(
  filters: PaymentFilterState,
  { bounds, defaultPageSize, overrides = {} }: BuildPaymentParamsOptions,
): Params {
  return {
    q: filters.search,
    status: filters.status,
    category: filters.declineCategory,
    time: filters.time === "all" ? null : filters.time,
    sort: filters.sort === "newest" ? null : filters.sort,
    perPage: filters.pageSize === defaultPageSize ? null : String(filters.pageSize),
    amountMin: filters.amountMinCents > bounds.minCents ? String(filters.amountMinCents) : null,
    amountMax: filters.amountMaxCents < bounds.maxCents ? String(filters.amountMaxCents) : null,
    ...overrides,
  };
}
