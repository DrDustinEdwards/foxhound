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
