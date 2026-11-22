import { FEATURE_FILTERS, type FeatureFilterValue } from "~/lib/marketing/features-content";

// The /features product filter: six pills, All first, exactly one active. The pills are Capsomer's filter chips (capsomer/chips.css): a pressed chip carries a tick, the accent edge and the tint, so the active one is not marked by color alone. One-active behavior means a press moves the choice rather than adding to it; Capsomer's FilterChips React wrapper is multi-select, which is why the chip markup is used here directly. The row is a labeled group of toggle buttons with aria-pressed. A visually hidden live line says what the filter left; no visible count.
export function FeatureFilter({
  active,
  onChange,
  shownCount,
  totalCount,
}: {
  active: FeatureFilterValue;
  onChange: (value: FeatureFilterValue) => void;
  shownCount: number;
  totalCount: number;
}) {
  return (
    // The mb-10 sits on a wrapper so the Capsomer group carries no Foxhound class.
    <div className="fh-feature-filter-block">
      {/* Recova's filter: mono chips, the pressed one filled amber. */}
      <div
        className="fh-mk-chips cap-chips"
        data-variant="solid"
        role="group"
        aria-label="Filter features by product"
      >
        {FEATURE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className="cap-chip"
            aria-pressed={active === f}
            data-value={f}
            onClick={() => onChange(f)}
          >
            {f}
          </button>
        ))}
        <span className="cap-sr-only" role="status">
          {active === "All"
            ? `Showing all ${totalCount} features`
            : `Showing ${shownCount} of ${totalCount} features: ${active}`}
        </span>
      </div>
    </div>
  );
}
