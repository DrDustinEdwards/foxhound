import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// Shared stat-card presentation (built in 5a for the dashboard, reused by the
// 5b recovery overview). One place for the label/value/subtext layout so
// surfaces stay visually identical.
//
// `icon` is OPTIONAL on purpose. Legacy's /recovery/dashboard StatCards carry a
// lucide icon per card; the other ten consumers of this component render
// surfaces whose legacy counterparts have not been walked yet. An optional prop
// adds the icon where parity calls for it and changes nothing anywhere else.
//
// The container's `rounded-lg` and `p-4` are DELIBERATELY NOT CHANGED to legacy
// S5's `rounded-[12px] p-5`. This component has eleven consumers across S2, S5,
// S6, S7, S9, disputes, intelligence and admin, and nine of those surfaces are
// unwalked. Restyling them all to match the one surface whose legacy values are
// known is the defect DESIGN.md names for the type scale, one component over.
// Held for a ruling 63 decision on whether this component splits per surface.

export function StatCard({
  label,
  value,
  valueClassName,
  subtext,
  icon: Icon,
  iconClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  subtext?: string;
  icon?: LucideIcon;
  iconClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      {Icon ? (
        <Icon
          className={`mb-2 h-4 w-4 ${iconClassName ?? "text-text-tertiary"}`}
          strokeWidth={1.5}
          aria-hidden="true"
        />
      ) : null}
      <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">{label}</p>
      <p className={`mt-2 font-mono text-display font-medium ${valueClassName ?? "text-text"}`}>
        {value}
      </p>
      {subtext ? <p className="mt-1 text-label text-text-tertiary">{subtext}</p> : null}
    </div>
  );
}

/** The marketing previews' stat card (Recova's disputes and Intelligence
 *  preview cards): a label over whatever figure the caller puts in. Recova's
 *  card leads nowhere, so it is a panel with a figure in it, not Capsomer's
 *  stat tile, which is always a link or a button. */
export function PreviewStatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="cap-panel">
      <div className="cap-panel-body">
        <div>
          <p className="m-0 mb-1 text-micro font-medium uppercase tracking-[0.06em] text-text-tertiary">{label}</p>
          {children}
        </div>
      </div>
    </li>
  );
}
