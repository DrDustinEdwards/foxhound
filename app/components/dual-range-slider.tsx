// Dual-handle amount range (TASK-foxhound-recovery-surface-parity.md Phase 3,
// /recovery/payments). Two overlapping native range inputs on a shared
// track (styling in app.css's .dual-range-input rules): no JS, no drag
// logic, full native keyboard support. Submits as two plain named form
// fields, read like any other filter in the loader's search params - this
// is a GET-form control, not a controlled/client-filtered widget.

export function DualRangeSlider({
  min,
  max,
  valueMin,
  valueMax,
  minName,
  maxName,
}: {
  min: number;
  max: number;
  valueMin: number;
  valueMax: number;
  minName: string;
  maxName: string;
}) {
  return (
    <div className="relative h-5 w-full">
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-border" />
      <input
        type="range"
        name={minName}
        min={min}
        max={max}
        defaultValue={valueMin}
        aria-label="Minimum amount"
        className="dual-range-input absolute inset-x-0 top-1/2 w-full -translate-y-1/2"
      />
      <input
        type="range"
        name={maxName}
        min={min}
        max={max}
        defaultValue={valueMax}
        aria-label="Maximum amount"
        className="dual-range-input absolute inset-x-0 top-1/2 w-full -translate-y-1/2"
      />
    </div>
  );
}
