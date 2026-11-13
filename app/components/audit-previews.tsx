import {
  AUDIT_HISTORY_EXAMPLE,
  AUDIT_SCOPES,
  AUDIT_SUMMARY_EXAMPLE,
} from "~/lib/marketing/audit-copy";

// The previews on /product/audit, Recova's three feature-block UIs: the
// scope card (components/docs/AuditScopeCard.tsx, blob dc1d18dd) and the two
// local previews in app/(marketing)/product/audit/page.tsx (blob 210ce79d),
// AISummaryPreview and AuditHistoryPreview.
//
// Content and layout are Recova's; the parts are Capsomer's: each scope
// is a Capsomer panel, as Recova's is a bordered surface card. Accents are amber
//, on the glyphs and on "Monthly auto-run on" as on Recova's. Text is
// at Recova's sizes.
//
// Recova's previews are hand-written examples, and so are these: the audit is
// a one-off diagnostic of a merchant's own Stripe account, and the demo seed
// carries no audit run to draw from. The copy module says where each example
// differs from Recova's and why.

/** Recova's scope card: four bordered cards, two columns from the small
 *  breakpoint, each a glyph beside a title and its line. */
export function AuditScopeCard() {
  return (
    <div className="fh-auditprev-block">
      <ul className="fh-mk-doc-cards">
        {AUDIT_SCOPES.map((s) => (
          <li key={s.title} className="cap-panel">
            <div className="cap-panel-body">
              <div className="fh-mk-point-wide">
                <span
                  aria-hidden="true"
                  className="fh-auditprev-label fh-mono fh-card-title fh-tight fh-accent"
                >
                  {s.icon}
                </span>
                <div>
                  <div className="fh-auditprev-block-2 fh-copy fh-medium fh-text">{s.title}</div>
                  <div className="fh-small fh-relaxed fh-soft">{s.desc}</div>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Recova's AISummaryPreview: a micro label over the summary, figures in mono. */
export function AISummaryPreview() {
  return (
    <div className="fh-auditprev-block">
      <div className="fh-auditprev-block-3 fh-tiny fh-medium fh-quiet fh-caps-wide">AI Summary</div>
      <p className="fh-copy fh-relaxed fh-soft">
        {AUDIT_SUMMARY_EXAMPLE.map((part, i) =>
          typeof part === "string" ? (
            part
          ) : (
            <span key={i} className="fh-mono">
              {part.figure}
            </span>
          ),
        )}
      </p>
    </div>
  );
}

/** Recova's AuditHistoryPreview: a header strip, then one row per run. */
export function AuditHistoryPreview() {
  return (
    <div className="fh-auditprev-block-4">
      <div className="fh-auditprev-row">
        <span className="fh-tiny fh-medium fh-quiet fh-caps-wide">Audit history</span>
        <span className="fh-mono fh-tiny fh-accent">Monthly auto-run on</span>
      </div>
      <ul className="fh-mk-rules">
        {AUDIT_HISTORY_EXAMPLE.map((run) => (
          <li key={run.date} className="fh-auditprev-item">
            <span className="fh-mono fh-small fh-soft">{run.date}</span>
            <span className="fh-caption fh-quiet">{run.summary}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
