import { FEATURE_FILTERS, type FeatureFilterValue } from "~/lib/marketing/features-content";

// The /features product filter (J60). Recova's spec is
// components/features/FeatureFilter.tsx (blob 4e2ef1fa): six pills, All first,
// exactly one active, flex-wrap with gap-2 and mb-10 under the header. The
// pills are Capsomer's filter chips (capsomer/chips.css), the family part for
// "filter a list by up to six values" (Q12): a pressed chip carries a tick,
// the accent edge and the tint, so the active one is not marked by color
// alone. Recova's one-active behavior is kept, so a press moves the choice
// rather than adding to it; Capsomer's FilterChips React wrapper is
// multi-select, which is why the chip markup is used here directly.
//
// Recova marks the row up as a tablist of tabs with aria-selected but no tab
// panels. Capsomer's chips are a labeled group of toggle buttons with
// aria-pressed, which says what the control does. The group keeps Recova's
// accessible name. A visually hidden live line says what the filter left,
// as Capsomer's chips do with a visible count; Recova shows no count, so the
// line is for screen readers only and the page looks as Recova's does.
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
    // Recova's mb-10 sits on a wrapper so the Capsomer group carries no Foxhound class.
    <div className="mb-10">
      {/* Recova's filter: mono chips, the pressed one filled amber. */}
      <div className="cap-chips [--ui:var(--mono)] [&_.cap-chip]:min-h-[30px] [&_.cap-chip]:text-caption" data-variant="solid" role="group" aria-label="Filter features by product">
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
        <span className="sr-only" role="status">
          {active === "All"
            ? `Showing all ${totalCount} features`
            : `Showing ${shownCount} of ${totalCount} features: ${active}`}
        </span>
      </div>
    </div>
  );
}
