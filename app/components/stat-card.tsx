// Shared stat-card presentation (built in 5a for the dashboard, reused by the
// 5b recovery overview). One place for the label/value/subtext layout so
// surfaces stay visually identical.

export function StatCard({
  label,
  value,
  valueClassName,
  subtext,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  subtext?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">{label}</p>
      <p className={`mt-2 font-mono text-display font-medium ${valueClassName ?? "text-text"}`}>
        {value}
      </p>
      {subtext ? <p className="mt-1 text-label text-text-tertiary">{subtext}</p> : null}
    </div>
  );
}
