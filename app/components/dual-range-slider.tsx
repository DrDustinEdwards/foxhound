import { useEffect, useRef, useState } from "react";

import { sliderDollars } from "~/lib/recovery/payments-list";

// Recova's amount slider (components/AmountRangeSlider.tsx at blob d6bb58e8,
// read whole) for /recovery/payments: "Amount" with the chosen span over the
// track, the span filled between the two handles, the account's ends under
// it, $10 steps, and the filter applied a quarter second after a handle stops.
//
// Capsomer 0.9.0 has no range slider, so this stays the page's own (named as a
// Capsomer gap in the J75 pull request). Two native range inputs share one
// track (styling in app.css's .dual-range-input rules), so the keyboard works
// with no script, and both carry names, so the filter form still submits them
// when script has not run.
//
// Recova's fixed 240px basis applies on the wide layout only: in its phone
// column the same basis became a 240px tall gap under the slider.

const COMMIT_DELAY_MS = 250;

export function DualRangeSlider({
  min,
  max,
  valueMin,
  valueMax,
  step,
  minName,
  maxName,
  onCommit,
}: {
  min: number;
  max: number;
  valueMin: number;
  valueMax: number;
  step: number;
  minName: string;
  maxName: string;
  onCommit?: (nextMin: number, nextMax: number) => void;
}) {
  const [lo, setLo] = useState(valueMin);
  const [hi, setHi] = useState(valueMax);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new URL brings new values; the handles follow it, as Recova's do. Kept
  // during render rather than in an effect (React's "storing information from
  // previous renders").
  const [from, setFrom] = useState({ valueMin, valueMax });
  if (from.valueMin !== valueMin || from.valueMax !== valueMax) {
    setFrom({ valueMin, valueMax });
    setLo(valueMin);
    setHi(valueMax);
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function commit(nextMin: number, nextMax: number) {
    if (!onCommit) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(nextMin, nextMax), COMMIT_DELAY_MS);
  }

  const range = max - min || 1;
  const leftPct = ((lo - min) / range) * 100;
  const rightPct = ((hi - min) / range) * 100;

  return (
    <div className="md:min-w-[220px] md:flex-[0_0_240px]">
      <div className="mb-1.5 flex items-center justify-between text-micro">
        <span className="text-text-subtle">Amount</span>
        <span className="font-mono text-brand-text">
          {sliderDollars(lo)} – {sliderDollars(hi, true, max)}
        </span>
      </div>
      <div className="relative h-6 w-full">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-border" />
        <div
          className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-brand"
          style={{ left: `${leftPct}%`, right: `${100 - rightPct}%` }}
        />
        <input
          type="range"
          name={minName}
          min={min}
          max={max}
          step={step}
          value={lo}
          onChange={(e) => {
            const next = Math.min(Number(e.target.value), hi - step);
            setLo(next);
            commit(next, hi);
          }}
          aria-label="Minimum amount"
          aria-valuetext={sliderDollars(lo)}
          className="dual-range-input absolute inset-x-0 top-1/2 h-6 w-full -translate-y-1/2"
        />
        <input
          type="range"
          name={maxName}
          min={min}
          max={max}
          step={step}
          value={hi}
          onChange={(e) => {
            const next = Math.max(Number(e.target.value), lo + step);
            setHi(next);
            commit(lo, next);
          }}
          aria-label="Maximum amount"
          aria-valuetext={sliderDollars(hi, true, max)}
          className="dual-range-input absolute inset-x-0 top-1/2 h-6 w-full -translate-y-1/2"
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-micro text-text-subtle">
        <span>{sliderDollars(min)}</span>
        <span>{sliderDollars(max, true, max)}</span>
      </div>
    </div>
  );
}
