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
}: {
  data: BarDatum[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (data.length === 0) return null;
  const values = data.map((d) => d.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const labelSpace = 20;
  const chartHeight = height - labelSpace;
  const zeroY = chartHeight - ((0 - min) / range) * chartHeight;
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
