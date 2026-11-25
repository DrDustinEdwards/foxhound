import { countText } from "capsomer/content";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Form, useNavigate } from "react-router";
import { ButtonLink, Link } from "capsomer/react/link";
import { FilterBar, isFiltered } from "capsomer/react/filter-bar";
import { RangeSlider } from "capsomer/react/range-slider";
import {
  amountSliderStep,
  DECLINE_CATEGORY_WORDS,
  PAYMENTS_DEFAULT_PAGE_SIZE,
  PAYMENTS_PAGE_SIZE_OPTIONS,
  declineWord,
  sliderAmount,
} from "~/lib/recovery/payments-list";
import {
  clearHref,
  countFor,
  DATE_RANGES,
  hrefWith,
  paramsFor,
  SORTS,
  STATUS_PILLS,
  type Filters,
  type PillCounts,
} from "~/lib/recovery/payments-page";
import type { AmountBounds } from "~/lib/recovery/queries.server";

export function PaymentsFilters({
  filters,
  bounds,
  pillCounts,
  resultCount,
}: {
  filters: Filters;
  bounds: AmountBounds;
  pillCounts: PillCounts;
  resultCount: number;
}) {
  const navigate = useNavigate();

  // The filter bar submits the form as you type (after a pause, never mid-composition) and on each change of a control. The box follows the address when the address changes under it (Clear, Back), but not while a search it has already sent comes back.
  const [search, setSearch] = useState(filters.search);
  const sentSearch = useRef(filters.search);
  useEffect(() => {
    if (filters.search !== sentSearch.current) {
      sentSearch.current = filters.search;
      setSearch(filters.search);
    }
  }, [filters.search]);
  const followsAddress = () => undefined;
  function onFilterSubmit(e: FormEvent<HTMLFormElement>) {
    sentSearch.current = search.trim();
    // A new currency starts its amount range over: the handles hold the old
    // currency's amounts, so they are not sent with it.
    const picked = new FormData(e.currentTarget).get("currency");
    if (typeof picked === "string" && picked !== bounds.currency) {
      e.preventDefault();
      void navigate(
        hrefWith(filters, bounds, {
          currency: picked === bounds.defaultCurrency ? "" : picked,
          amountMin: "",
          amountMax: "",
        }),
        { preventScrollReset: true },
      );
    }
  }

  const hasActiveFilters = isFiltered(paramsFor(filters, bounds), [
    "q",
    "status",
    "category",
    "time",
    "amountMin",
    "amountMax",
  ]);

  return (
    <>
      {/* Recova's PaymentsFilters: one panel, two rows. */}
      <div className="cap-panel">
        <div className="cap-panel-body">
          <FilterBar
            label="Filter payments"
            Form={Form}
            live
            className="fh-filter-panel"
            onSubmit={onFilterSubmit}
            count={countText(resultCount, resultCount, { noun: "result", plural: "results" })}
            clearHref={hasActiveFilters ? clearHref(filters, bounds) : null}
            clearLabel="Clear filters"
            renderLink={({ href, children }) => (
              <ButtonLink to={href} variant="quiet" size="sm">
                {children}
              </ButtonLink>
            )}
          >
            <div className="fh-filter-fill cap-stack fh-small" data-gap="5">
              <div className="fh-payments-filters">
                <div className="fh-payments-search">
                  <input
                    className="cap-input"
                    type="text"
                    name="q"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name, email, or plan..."
                    aria-label="Search payments"
                  />
                </div>
                <div className="fh-payments-scroll">
                  {/* Capsomer's segmented control, as its markup: its React
                    wrapper hides the legend with cap-sr-only, which lives in
                    Capsomer's base.css, which the app does not load, so the
                    legend would show where Recova shows none. */}
                  <fieldset className="cap-seg">
                    <legend className="cap-sr-only">Filter by status</legend>
                    <div className="cap-seg-options">
                      {STATUS_PILLS.map((pill) => (
                        <label key={pill.value}>
                          <input
                            type="radio"
                            name="status"
                            value={pill.value}
                            checked={filters.status === pill.value}
                            onChange={followsAddress}
                          />{" "}
                          {pill.label}{" "}
                          <span className="fh-mono">{countFor(pillCounts, pill.value)}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>
              </div>

              <div className="fh-payments-filters">
                <div className="cap-select-wrap">
                  <select
                    className="cap-select"
                    name="time"
                    aria-label="Filter by date range"
                    value={filters.time}
                    onChange={followsAddress}
                  >
                    {DATE_RANGES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="cap-select-wrap">
                  <select
                    className="cap-select"
                    name="category"
                    aria-label="Filter by decline category"
                    value={filters.declineCategory}
                    onChange={followsAddress}
                  >
                    <option value="">All declines</option>
                    {Object.keys(DECLINE_CATEGORY_WORDS).map((c) => (
                      <option key={c} value={c}>
                        {declineWord(c)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="cap-select-wrap">
                  <select
                    className="cap-select"
                    name="sort"
                    aria-label="Filter by sort order"
                    value={filters.sort}
                    onChange={followsAddress}
                  >
                    {SORTS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
                {bounds.currencies.length > 1 ? (
                  <div className="cap-select-wrap">
                    <select
                      className="cap-select"
                      name="currency"
                      aria-label="Currency of the amount range"
                      value={bounds.currency}
                      onChange={followsAddress}
                    >
                      {bounds.currencies.map((c) => (
                        <option key={c} value={c}>
                          {c.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <RangeSlider
                  className="fh-payments-select"
                  label="Amount"
                  min={bounds.minCents}
                  max={bounds.maxCents}
                  low={filters.amountMinCents}
                  high={filters.amountMaxCents}
                  step={amountSliderStep(bounds.currency)}
                  names={["amountMin", "amountMax"]}
                  handleLabels={["Minimum amount", "Maximum amount"]}
                  format={(minor, which) =>
                    sliderAmount(minor, bounds.currency, which === "high", bounds.maxCents)
                  }
                />
              </div>
            </div>
            {/* The page size rides along when the form submits. */}
            {filters.pageSize !== PAYMENTS_DEFAULT_PAGE_SIZE ? (
              <input type="hidden" name="perPage" value={String(filters.pageSize)} />
            ) : null}
          </FilterBar>
        </div>
      </div>

      {/* Recova's rows-per-page links, right-aligned between the panel and the
          table, as Capsomer's link chips. */}
      <nav aria-label="Rows per page" className="fh-payments-rows">
        <span className="fh-payments-rows-label fh-tiny fh-quiet" aria-hidden="true">
          Rows per page
        </span>
        <ul className="cap-chips">
          {PAYMENTS_PAGE_SIZE_OPTIONS.map((n) => (
            <li key={n}>
              <Link
                className="cap-chip"
                data-size="sm"
                to={hrefWith(filters, bounds, {
                  perPage: n === PAYMENTS_DEFAULT_PAGE_SIZE ? "" : String(n),
                })}
                aria-current={filters.pageSize === n ? "true" : undefined}
              >
                {n === "all" ? "All" : n}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
