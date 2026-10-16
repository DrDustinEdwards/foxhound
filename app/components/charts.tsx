// Shared hand-rolled SVG chart primitives (DESIGN.md Charts section). Built once
// here in slice 5a, reused by 5e (Intelligence) and Phase 6. No charting library:
// a library's own inline-styled SVG fights the no-inline-hex / one-accent-per-card
// / reserved-purple rules, and its responsive container is client-only (no SSR on
// Workers). Every primitive here is a pure, SSR-safe function component: colors
// come from `currentColor` (the parent sets a Tailwind text-color class) or from
// token utility classes on individual marks, never inline hex. Tooltips are an
// optional client-side enhancement per DESIGN.md; none are built here, numbers
// already render in DM Mono beside every chart.

export interface MultiLineSeries {
  name: string;
  /** Tailwind text-color utility controlling this series' stroke via currentColor. */
  colorClassName: string;
  /** Rendered dashed, for a secondary series that should read as context rather
   *  than as the subject of the chart. */
  dashed?: boolean;
  /** One entry per label. null is a genuine gap (no data for that point) and
   *  breaks the line, rather than being drawn as a zero. */
  values: (number | null)[];
}

/**
 * Which x positions carry a label. Always the first and the last, then as many
 * evenly spaced interior ones as `maxLabels` allows, which is legacy recharts'
 * `interval="preserveStartEnd"` behaviour expressed without a measurement pass.
 * An interior label landing within half a stride of the end is dropped, because
 * that is the pair that would collide.
 */
export function xLabelIndexes(count: number, maxLabels: number): number[] {
  const last = count - 1;
  if (last <= 0) return [0];
  const room = Math.max(2, Math.min(maxLabels, count));
  const stride = Math.max(1, Math.ceil(last / (room - 1)));
  const indexes: number[] = [];
  for (let i = 0; i < last; i += stride) indexes.push(i);
  const lastShown = indexes[indexes.length - 1] ?? 0;
  if (indexes.length > 1 && last - lastShown <= stride / 2) indexes.pop();
  indexes.push(last);
  return indexes;
}

/**
 * Two or more labeled lines on a shared scale, with a legend and a y axis.
 *
 * This exists for comparisons where the relationship between the series IS the content, such as
 * involuntary against voluntary churn. A null in `values` leaves a gap instead
 * of dropping to zero, because "no snapshot that week" and "zero percent that
 * week" are different claims and drawing them the same way misreports the data.
 *
 * The y axis carries ticks here, unlike the other primitives, because there is
 * no single headline number a caller could print beside a two-series comparison
 * to substitute for the scale.
 *
 * REPAIRED under ruling 398 toward legacy's real ChurnRateChart
 * (recova app/(app)/intelligence/churn/components/ChurnRateChart.tsx), which is
 * recharts inside a ResponsiveContainer. Three measured breakages and the one
 * structural cause behind all three:
 *
 *   The whole chart used to be a single SVG with a fixed 480x180 viewBox,
 *   `width="100%"`, a pixel `height`, and no preserveAspectRatio. Uniform
 *   scaling is then capped by the height, so the drawing stayed 480px wide and
 *   sat in the middle of a 1168px card with the rest empty (breakage 1); the
 *   legend was drawn INSIDE that box at y=10 against a top gridline at y=20
 *   (breakage 2); and only the first and last x labels were emitted, because
 *   any interior label would have overprinted at 480px (breakage 3).
 *
 *   Adding `preserveAspectRatio="none"` is NOT the fix: that is what the other
 *   primitives here do, and it is why the S9 step-performance chart's labels
 *   render as one run of colliding stretched text. A fluid width at a fixed
 *   height cannot scale text uniformly, so the text leaves the SVG. Only the
 *   plot geometry is stretched, in a unitless 0-100 box with non-scaling
 *   strokes; the y ticks, x labels and legend are real HTML around it, at their
 *   own size. That is legacy's rendered result without legacy's client-side
 *   measurement pass, which DESIGN.md's Charts section rules out.
 *
 *   Legend position follows legacy's `<Legend />` default (verticalAlign
 *   "bottom", centered), so it is below the plot rather than over it. Gridlines
 *   go with it: legacy renders no CartesianGrid, no axis line and no tick line
 *   on this chart, only the tick labels.
 */
export function MultiLine({
  labels,
  series,
  yTickFormat = (v) => String(v),
  yTickCount = 4,
  maxXLabels = 8,
  height = 180,
  referenceValue,
  showLegend = true,
  className,
}: {
  labels: string[];
  series: MultiLineSeries[];
  yTickFormat?: (value: number) => string;
  yTickCount?: number;
  /** Ceiling on x labels drawn, including the first and the last. */
  maxXLabels?: number;
  height?: number;
  /** A dashed horizontal rule at this y value, legacy's recharts
   *  `<ReferenceLine>`. Drawn only when the value falls inside the plotted
   *  range, because a reference line clamped to an edge reads as an axis. */
  referenceValue?: number;
  /** Legacy renders a `<Legend />` only where more than one series shares the
   *  plot; on a single-series chart the swatch is noise. Additive default, so
   *  the existing two-series consumer is untouched (199's rule). */
  showLegend?: boolean;
  className?: string;
}) {
  if (labels.length < 2 || series.length === 0) return null;
  const present = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (present.length === 0) return null;

  const labelSpace = 20;
  // Reserved only when it is drawn, so a single-series chart gives the strip
  // back to the plot rather than leaving a 20px hole under the x labels.
  const legendSpace = showLegend ? 20 : 0;
  const axisWidth = 40;
  const plotHeight = height - labelSpace - legendSpace;

  // Always include zero: a churn-rate chart whose axis starts at 2% makes a
  // flat line look like a cliff. A reference value joins the extent for the
  // same reason, so an NRR series sitting entirely above 100 still shows the
  // 100 line it is being compared against.
  const extent = referenceValue === undefined ? present : [...present, referenceValue];
  const max = Math.max(...extent, 0);
  const min = Math.min(...extent, 0);
  const range = max - min || 1;
  // Percentages of the plot box, so the browser does the width arithmetic the
  // server cannot.
  const x = (i: number) => (i / (labels.length - 1)) * 100;
  const y = (v: number) => 100 - ((v - min) / range) * 100;

  const ticks = Array.from({ length: yTickCount + 1 }, (_, i) => min + (range * i) / yTickCount);
  const shownXLabels = xLabelIndexes(labels.length, maxXLabels);

  return (
    <div className={className}>
      <div className="flex" style={{ height: plotHeight }}>
        <div className="relative shrink-0" style={{ width: axisWidth }}>
          {ticks.map((t, i) => (
            <span
              key={`tick-${i}`}
              className="absolute right-1.5 -translate-y-1/2 font-mono text-micro text-text-subtle"
              style={{ top: `${y(t)}%` }}
            >
              {yTickFormat(t)}
            </span>
          ))}
        </div>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-hidden="true"
        >
          {referenceValue === undefined ? null : (
            <line
              x1={0}
              y1={y(referenceValue)}
              x2={100}
              y2={y(referenceValue)}
              className="stroke-border-i"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {series.map((s) => {
            // Split into runs of consecutive non-null points so a gap breaks the
            // line instead of drawing a straight segment across missing data.
            const runs: string[] = [];
            let current: string[] = [];
            s.values.forEach((v, i) => {
              if (v === null) {
                if (current.length > 1) runs.push(current.join(" "));
                current = [];
                return;
              }
              current.push(`${x(i)},${y(v)}`);
            });
            if (current.length > 1) runs.push(current.join(" "));
            return (
              <g key={s.name} className={s.colorClassName}>
                {runs.map((points, ri) => (
                  <polyline
                    key={ri}
                    points={points}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeDasharray={s.dashed ? "4 2" : undefined}
                    // Without this the non-uniform stretch thickens the stroke
                    // horizontally and smears the dash pattern with it.
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="relative" style={{ height: labelSpace, marginLeft: axisWidth }}>
        {shownXLabels.map((i) => {
          const isFirst = i === 0;
          const isLast = i === labels.length - 1;
          return (
            <span
              key={`x-${i}`}
              className={`absolute top-1 font-mono text-micro text-text-subtle ${
                isFirst || isLast ? "" : "-translate-x-1/2"
              }`}
              style={isLast ? { right: 0 } : { left: `${x(i)}%` }}
            >
              {labels[i]}
            </span>
          );
        })}
      </div>
      <div className="flex items-center justify-center gap-4" style={{ height: legendSpace }}>
        {(showLegend ? series : []).map((s) => (
          <span key={`legend-${s.name}`} className="flex items-center gap-1.5">
            <svg
              width={14}
              height={4}
              viewBox="0 0 14 4"
              aria-hidden="true"
              className={s.colorClassName}
            >
              <line
                x1={0}
                y1={2}
                x2={14}
                y2={2}
                stroke="currentColor"
                strokeWidth={2}
                strokeDasharray={s.dashed ? "4 2" : undefined}
              />
            </svg>
            <span className="font-mono text-micro text-text-subtle">{s.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export interface StackedBarSeries {
  name: string;
  /** Tailwind text-color utility controlling this series' fill via currentColor. */
  colorClassName: string;
  /** One entry per label. Counts, so never null: a band with nobody in it is a
   *  real zero, unlike MultiLine's null-is-a-gap rate series. */
  values: number[];
}

/**
 * Bars stacked per x position, with a y axis, x labels and a legend.
 *
 * Ported toward legacy's HealthDistributionChart and MRRMovementChart
 * (recova app/(app)/intelligence/dashboard/components/), both of which are
 * recharts `<BarChart>` with `<Bar stackId>` inside a ResponsiveContainer.
 *
 * It does not use a fixed pixel viewBox, the defect ruling 399 measured and
 * repaired in MultiLine (and which the single-series bar primitive this file
 * once held, removed in J64, carried): a fixed pixel viewBox at `width="100%"` with its
 * `<text>` INSIDE the box. Its `preserveAspectRatio="none"` then stretches the
 * label glyphs horizontally with the plot, which is the S9 step-performance
 * chart's colliding-label defect. So the geometry here follows MultiLine's
 * repaired shape: only the plot is stretched, in a unitless 0-100 box, and the
 * y ticks, x labels and legend are real HTML around it at their own size.
 *
 * ONE DELIBERATE DIVERGENCE FROM LEGACY, flagged rather than slipped in: legacy
 * rounds the top bar's outer corners (`radius={[2, 2, 0, 0]}`). A 2px rx inside
 * a non-uniformly stretched box is scaled with the box and smears into an
 * ellipse whose width tracks the card, so it is omitted rather than rendered
 * wrong. Same reasoning as 399's non-scaling strokes, applied to a corner.
 */
export function StackedBars({
  labels,
  series,
  yTickFormat = (v) => String(v),
  yTickCount = 4,
  maxXLabels = 8,
  height = 200,
  className,
}: {
  labels: string[];
  series: StackedBarSeries[];
  yTickFormat?: (value: number) => string;
  yTickCount?: number;
  /** Ceiling on x labels drawn, including the first and the last. */
  maxXLabels?: number;
  height?: number;
  className?: string;
}) {
  if (labels.length === 0 || series.length === 0) return null;

  // Stacks run both ways: a movement chart puts churn and contraction below the
  // baseline. Positives and negatives accumulate separately from zero, which is
  // recharts' behaviour for two stackIds sharing an axis.
  const positiveTotals = labels.map((_, i) =>
    series.reduce((sum, s) => sum + Math.max(s.values[i] ?? 0, 0), 0),
  );
  const negativeTotals = labels.map((_, i) =>
    series.reduce((sum, s) => sum + Math.min(s.values[i] ?? 0, 0), 0),
  );
  const max = Math.max(...positiveTotals, 0);
  const min = Math.min(...negativeTotals, 0);
  const range = max - min || 1;

  const labelSpace = 20;
  const legendSpace = 20;
  const axisWidth = 40;
  const plotHeight = height - labelSpace - legendSpace;

  const y = (v: number) => 100 - ((v - min) / range) * 100;
  const slot = 100 / labels.length;
  const barWidth = slot * 0.6;

  const ticks = Array.from({ length: yTickCount + 1 }, (_, i) => min + (range * i) / yTickCount);
  const shownXLabels = xLabelIndexes(labels.length, maxXLabels);
  const zeroY = y(0);

  return (
    <div className={className}>
      <div className="flex" style={{ height: plotHeight }}>
        <div className="relative shrink-0" style={{ width: axisWidth }}>
          {ticks.map((t, i) => (
            <span
              key={`tick-${i}`}
              className="absolute right-1.5 -translate-y-1/2 font-mono text-micro text-text-subtle"
              style={{ top: `${y(t)}%` }}
            >
              {yTickFormat(t)}
            </span>
          ))}
        </div>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-hidden="true"
        >
          {/* The baseline, drawn only when the data actually crosses it. */}
          {min < 0 ? (
            <line
              x1={0}
              y1={zeroY}
              x2={100}
              y2={zeroY}
              className="stroke-border"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {labels.map((label, i) => {
            const x = i * slot + (slot - barWidth) / 2;
            let positiveBase = 0;
            let negativeBase = 0;
            return (
              <g key={`${label}-${i}`}>
                {series.map((s) => {
                  const value = s.values[i] ?? 0;
                  if (value === 0) return null;
                  const base = value > 0 ? positiveBase : negativeBase;
                  const top = y(base + value);
                  const bottom = y(base);
                  if (value > 0) positiveBase += value;
                  else negativeBase += value;
                  return (
                    <rect
                      key={s.name}
                      x={x}
                      y={Math.min(top, bottom)}
                      width={barWidth}
                      height={Math.abs(bottom - top)}
                      fill="currentColor"
                      className={s.colorClassName}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="relative" style={{ height: labelSpace, marginLeft: axisWidth }}>
        {shownXLabels.map((i) => {
          const isFirst = i === 0;
          const isLast = i === labels.length - 1;
          return (
            <span
              key={`x-${i}`}
              className={`absolute top-1 font-mono text-micro text-text-subtle ${
                isFirst || isLast ? "" : "-translate-x-1/2"
              }`}
              style={isLast ? { right: 0 } : { left: `${i * slot + slot / 2}%` }}
            >
              {labels[i]}
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-4" style={{ height: legendSpace }}>
        {series.map((s) => (
          <span key={`legend-${s.name}`} className="flex items-center gap-1.5">
            <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden="true" className={s.colorClassName}>
              <rect width={8} height={8} rx={2} fill="currentColor" />
            </svg>
            <span className="font-mono text-micro text-text-subtle">{s.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export interface GroupedBarSeries {
  name: string;
  /** Tailwind text-color utility controlling this series' bars via currentColor. */
  colorClassName: string;
  values: number[];
}

/** Multiple series (e.g. open rate / click rate) grouped side by side per
 *  label, with a small legend, to compare two rates per category. */
export function GroupedBars({
  labels,
  series,
  max = 100,
  width = 480,
  height = 180,
  className,
}: {
  labels: string[];
  series: GroupedBarSeries[];
  /** Fixed value ceiling (e.g. 100 for a percentage scale) rather than derived
   *  from the data, so a chart of rates never rescales per render. */
  max?: number;
  width?: number;
  height?: number;
  className?: string;
}) {
  if (labels.length === 0 || series.length === 0) return null;
  const labelSpace = 20;
  const legendSpace = 20;
  const chartHeight = height - labelSpace - legendSpace;
  const groupSlot = width / labels.length;
  const barGap = 2;
  const barWidth = (groupSlot * 0.7) / series.length;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-hidden="true"
    >
      <line
        x1={0}
        y1={legendSpace + chartHeight}
        x2={width}
        y2={legendSpace + chartHeight}
        className="stroke-border"
        strokeWidth={1}
      />
      {labels.map((label, gi) => {
        const groupX = gi * groupSlot + (groupSlot - barWidth * series.length) / 2;
        return (
          <g key={`${label}-${gi}`}>
            {series.map((s, si) => {
              const value = s.values[gi] ?? 0;
              const barHeight = Math.max((value / max) * chartHeight, value === 0 ? 0 : 1);
              const x = groupX + si * barWidth;
              const y = legendSpace + chartHeight - barHeight;
              return (
                <rect
                  key={s.name}
                  x={x + barGap / 2}
                  y={y}
                  width={Math.max(barWidth - barGap, 1)}
                  height={barHeight}
                  rx={2}
                  fill="currentColor"
                  className={s.colorClassName}
                />
              );
            })}
            <text
              x={gi * groupSlot + groupSlot / 2}
              y={height - 4}
              textAnchor="middle"
              className="fill-current text-text-subtle font-mono text-micro"
            >
              {label}
            </text>
          </g>
        );
      })}
      {series.map((s, si) => (
        <g key={s.name} transform={`translate(${si * 90}, 10)`}>
          <rect width={8} height={8} rx={2} fill="currentColor" className={s.colorClassName} />
          <text x={12} y={8} className="fill-current text-text-subtle font-mono text-micro">
            {s.name}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** An inline horizontal meter (e.g. an Intelligence risk row). */
export function Meter({
  value,
  max = 100,
  tone = "neutral",
  label,
}: {
  value: number;
  max?: number;
  tone?: "positive" | "negative" | "neutral" | "caution";
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const fillClassName =
    tone === "positive"
      ? "bg-green"
      : tone === "negative"
        ? "bg-red"
        : tone === "caution"
          ? "bg-caution"
          : "bg-text-tertiary";

  return (
    <div
      className="flex items-center gap-2"
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div className="h-1.5 w-full rounded-full bg-border">
        <div className={`h-full rounded-full ${fillClassName}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-micro text-text-tertiary">{Math.round(pct)}%</span>
    </div>
  );
}
