// Shared hand-rolled SVG chart primitives (DESIGN.md Charts section). Built once
// here in slice 5a, reused by 5e (Intelligence) and Phase 6. No charting library:
// a library's own inline-styled SVG fights the no-inline-hex / one-amber-per-card
// / reserved-purple rules, and its responsive container is client-only (no SSR on
// Workers). Every primitive here is a pure, SSR-safe function component: colors
// come from `currentColor` (the parent sets a Tailwind text-color class) or from
// token utility classes on individual marks, never inline hex. Tooltips are an
// optional client-side enhancement per DESIGN.md; none are built here, numbers
// already render in DM Mono beside every chart.

/** A short trendline with no axes or labels (e.g. a stat-card accent). */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => `${i * step},${height - ((v - min) / range) * height}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-hidden="true"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

export interface LineAreaPoint {
  label: string;
  value: number;
}

/** A labeled line + area chart (e.g. an MRR trend). */
export function LineArea({
  points,
  width = 480,
  height = 160,
  className,
}: {
  points: LineAreaPoint[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const labelSpace = 20;
  const chartHeight = height - labelSpace;
  const step = width / (points.length - 1);
  const y = (v: number) => chartHeight - ((v - min) / range) * chartHeight;
  const linePoints = points.map((p, i) => `${i * step},${y(p.value)}`).join(" ");
  const areaPoints = `0,${chartHeight} ${linePoints} ${width},${chartHeight}`;

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
      <polygon points={areaPoints} fill="currentColor" opacity={0.12} />
      <polyline points={linePoints} fill="none" stroke="currentColor" strokeWidth={2} />
      {points.map((p, i) => (
        <text
          key={`${p.label}-${i}`}
          x={i === 0 ? 0 : i === points.length - 1 ? width : i * step}
          y={height - 4}
          textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
          className="fill-current text-text-subtle font-mono text-micro"
        >
          {p.label}
        </text>
      ))}
    </svg>
  );
}

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
 * Two or more labeled lines on a shared scale, with a legend and a y axis.
 *
 * Distinct from LineArea, which is one series with no axis: this exists for
 * comparisons where the relationship between the series IS the content, such as
 * involuntary against voluntary churn. A null in `values` leaves a gap instead
 * of dropping to zero, because "no snapshot that week" and "zero percent that
 * week" are different claims and drawing them the same way misreports the data.
 *
 * The y axis carries ticks here, unlike the other primitives, because there is
 * no single headline number a caller could print beside a two-series comparison
 * to substitute for the scale.
 */
export function MultiLine({
  labels,
  series,
  yTickFormat = (v) => String(v),
  yTickCount = 4,
  width = 480,
  height = 180,
  className,
}: {
  labels: string[];
  series: MultiLineSeries[];
  yTickFormat?: (value: number) => string;
  yTickCount?: number;
  width?: number;
  height?: number;
  className?: string;
}) {
  if (labels.length < 2 || series.length === 0) return null;
  const present = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (present.length === 0) return null;

  const labelSpace = 20;
  const legendSpace = 20;
  const axisWidth = 40;
  const chartHeight = height - labelSpace - legendSpace;
  const chartWidth = width - axisWidth;

  // Always include zero: a churn-rate chart whose axis starts at 2% makes a
  // flat line look like a cliff.
  const max = Math.max(...present, 0);
  const min = Math.min(...present, 0);
  const range = max - min || 1;
  const step = chartWidth / (labels.length - 1);
  const x = (i: number) => axisWidth + i * step;
  const y = (v: number) => legendSpace + chartHeight - ((v - min) / range) * chartHeight;

  const ticks = Array.from({ length: yTickCount + 1 }, (_, i) => min + (range * i) / yTickCount);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      className={className}
      role="img"
      aria-hidden="true"
    >
      {ticks.map((t, i) => (
        <g key={`tick-${i}`}>
          <line x1={axisWidth} y1={y(t)} x2={width} y2={y(t)} className="stroke-border" strokeWidth={1} opacity={i === 0 ? 1 : 0.4} />
          <text
            x={axisWidth - 6}
            y={y(t) + 3}
            textAnchor="end"
            className="fill-current text-text-subtle font-mono text-micro"
          >
            {yTickFormat(t)}
          </text>
        </g>
      ))}
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
              />
            ))}
          </g>
        );
      })}
      {labels.map((label, i) =>
        i === 0 || i === labels.length - 1 ? (
          <text
            key={`${label}-${i}`}
            x={x(i)}
            y={height - 4}
            textAnchor={i === 0 ? "start" : "end"}
            className="fill-current text-text-subtle font-mono text-micro"
          >
            {label}
          </text>
        ) : null,
      )}
      {series.map((s, si) => (
        <g key={`legend-${s.name}`} transform={`translate(${axisWidth + si * 110}, 10)`}>
          <line
            x1={0}
            y1={4}
            x2={10}
            y2={4}
            stroke="currentColor"
            strokeWidth={2}
            strokeDasharray={s.dashed ? "3 2" : undefined}
            className={s.colorClassName}
          />
          <text x={14} y={8} className="fill-current text-text-subtle font-mono text-micro">
            {s.name}
          </text>
        </g>
      ))}
    </svg>
  );
}

export interface BarDatum {
  label: string;
  value: number;
  /** Overrides the default sign-based tone (e.g. to force neutral). */
  tone?: "positive" | "negative" | "neutral";
}

const BAR_TONE_CLASS_NAME: Record<NonNullable<BarDatum["tone"]>, string> = {
  positive: "text-green",
  negative: "text-red",
  neutral: "text-text-tertiary",
};

/** A bar chart around a zero baseline; positive/negative bars grow from it, so
 *  it doubles as the "movements" (stacked/waterfall-style) chart in DESIGN.md. */
export function BarChart({
  data,
  width = 480,
  height = 160,
  className,
  topLabel,
}: {
  data: BarDatum[];
  width?: number;
  height?: number;
  className?: string;
  /** Optional text rendered above each bar's top edge (e.g. a percentage). Only
   *  sensible for non-negative data; used by the recovery-timing chart. */
  topLabel?: (d: BarDatum, i: number) => string;
}) {
  if (data.length === 0) return null;
  const values = data.map((d) => d.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const labelSpace = 20;
  const topLabelSpace = topLabel ? 16 : 0;
  const chartHeight = height - labelSpace - topLabelSpace;
  const zeroY = topLabelSpace + chartHeight - ((0 - min) / range) * chartHeight;
  const slot = width / data.length;
  const barWidth = slot * 0.6;

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
      <line x1={0} y1={zeroY} x2={width} y2={zeroY} className="stroke-border" strokeWidth={1} />
      {data.map((d, i) => {
        const barHeight = Math.max((Math.abs(d.value) / range) * chartHeight, d.value === 0 ? 0 : 1);
        const x = i * slot + (slot - barWidth) / 2;
        const y = d.value >= 0 ? zeroY - barHeight : zeroY;
        const tone = d.tone ?? (d.value > 0 ? "positive" : d.value < 0 ? "negative" : "neutral");
        return (
          <g key={`${d.label}-${i}`}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={2}
              fill="currentColor"
              className={BAR_TONE_CLASS_NAME[tone]}
            />
            {topLabel ? (
              <text
                x={x + barWidth / 2}
                y={Math.max(y - 4, 10)}
                textAnchor="middle"
                className="fill-current text-text-tertiary font-mono text-micro"
              >
                {topLabel(d, i)}
              </text>
            ) : null}
            <text
              x={x + barWidth / 2}
              y={height - 4}
              textAnchor="middle"
              className="fill-current text-text-subtle font-mono text-micro"
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export interface GroupedBarSeries {
  name: string;
  /** Tailwind text-color utility controlling this series' bars via currentColor. */
  colorClassName: string;
  values: number[];
}

/** Multiple series (e.g. open rate / click rate) grouped side by side per
 *  label, with a small legend. Used where a single BarChart series isn't
 *  enough to compare two rates per category. */
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
  tone?: "positive" | "negative" | "neutral" | "amber";
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const fillClassName =
    tone === "positive"
      ? "bg-green"
      : tone === "negative"
        ? "bg-red"
        : tone === "amber"
          ? "bg-amber"
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

export interface CohortRow {
  label: string;
  /** One value per column (e.g. months since cohort start), 0-100. */
  values: number[];
}

/** True when `value` structurally matches CohortRow[] (defensive: nothing in
 *  the schema fixes the shape of a JSON column). */
export function isCohortRows(value: unknown): value is CohortRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as CohortRow).label === "string" &&
        Array.isArray((r as CohortRow).values) &&
        (r as CohortRow).values.every((v) => typeof v === "number"),
    )
  );
}

/** A CSS grid of token-shaded cells (not an SVG chart), per DESIGN.md. */
export function CohortGrid({ rows }: { rows: CohortRow[] }) {
  if (rows.length === 0) return null;
  const columnCount = Math.max(...rows.map((r) => r.values.length));

  return (
    <div className="overflow-x-auto">
      <div
        className="grid gap-px font-mono text-micro"
        style={{ gridTemplateColumns: `8rem repeat(${columnCount}, 3rem)` }}
      >
        <div style={{ display: "contents" }}>
          <div />
          {Array.from({ length: columnCount }, (_, i) => (
            <div key={i} className="px-1 py-1 text-center text-text-subtle">
              {`M${i}`}
            </div>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.label} style={{ display: "contents" }}>
            <div className="truncate px-1 py-1 text-text-tertiary">{row.label}</div>
            {row.values.map((v, i) => (
              <div key={i} className="relative px-1 py-1 text-center text-text">
                <span
                  aria-hidden="true"
                  className="absolute inset-0 bg-green"
                  style={{ opacity: Math.max(0, Math.min(1, v / 100)) }}
                />
                <span className="relative">{Math.round(v)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
