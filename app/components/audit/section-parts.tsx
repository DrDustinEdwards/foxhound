import { SCOPE_UNREAD } from "~/lib/audit/render";

/** The call-to-action state. Every Foxhound account has Recovery and Disputes (app/lib/nav/manifest.ts), so a signed-in merchant is always "active". */
export type CtaState = "unauthenticated" | "active";

/** The one treatment for a scope that was not read, named so a merchant
 *  knows which figure is missing. */
export function Unread({ label }: { label: string }) {
  return (
    <div className="fh-auditsec-block">
      <div className="fh-small fh-text">{label}</div>
      <p className="fh-auditsec-text fh-tiny fh-quiet">{SCOPE_UNREAD}</p>
    </div>
  );
}

export function NoneDetected() {
  return <p className="fh-mb-5-5 fh-small fh-quiet">None detected in this period.</p>;
}

/** One line per currency, stacked, each an element of its own. */
export function Lines({ lines }: { lines: readonly string[] }) {
  if (lines.length === 1) return <>{lines[0]}</>;
  return (
    <span className="fh-auditsec-col">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

export function StatRow({
  label,
  primary,
  secondary,
  primaryClassName = "fh-text",
}: {
  label: string;
  primary: string | readonly string[];
  secondary?: string;
  primaryClassName?: string;
}) {
  return (
    <div className="fh-auditsec-row">
      <div>
        <div className="fh-small fh-text">{label}</div>
        {secondary ? <div className="fh-auditsec-text fh-tiny fh-quiet">{secondary}</div> : null}
      </div>
      <div className={`fh-nowrap fh-mono fh-body fh-semibold ${primaryClassName}`}>
        {typeof primary === "string" ? primary : <Lines lines={primary} />}
      </div>
    </div>
  );
}

export function Headline({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: readonly string[];
  valueClassName: string;
}) {
  return (
    <div className="fh-mb-3">
      <div className="fh-mb-2 fh-tiny fh-quiet fh-caps">{label}</div>
      {value.map((line) => (
        <div key={line} className={`fh-mono fh-display fh-bold ${valueClassName}`}>
          {line}
        </div>
      ))}
    </div>
  );
}
