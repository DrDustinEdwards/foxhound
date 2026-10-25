import { AUDIT_HISTORY_EXAMPLE, AUDIT_SCOPES, AUDIT_SUMMARY_EXAMPLE } from "~/lib/marketing/audit-copy";

// The previews on /product/audit (J55), Recova's three feature-block UIs: the
// scope card (components/docs/AuditScopeCard.tsx, blob dc1d18dd) and the two
// local previews in app/(marketing)/product/audit/page.tsx (blob 210ce79d),
// AISummaryPreview and AuditHistoryPreview.
//
// Content and layout are Recova's; the parts are Capsomer's (Q12): each scope
// is a Capsomer panel, as Recova's is a bordered surface card. Accents are amber
//, on the glyphs and on "Monthly auto-run on" as on Recova's. Text is
// on the five sizes (RULES.md 5.2), each Recova size taken to the nearest, a
// tie to the larger: 1.125rem to title, 0.875rem and 0.8125rem to label,
// 0.75rem to label, 0.6875rem to micro.
//
// Recova's previews are hand-written examples, and so are these: the audit is
// a one-off diagnostic of a merchant's own Stripe account, and the demo seed
// carries no audit run to draw from. The copy module says where each example
// differs from Recova's and why.

/** Recova's scope card: four bordered cards, two columns from the small
 *  breakpoint, each a glyph beside a title and its line. */
export function AuditScopeCard() {
  return (
    <div className="p-5">
      <ul className="m-0 my-6 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
        {AUDIT_SCOPES.map((s) => (
          <li key={s.title} className="cap-panel">
            <div className="cap-panel-body">
              <div className="flex items-start gap-3">
                <span aria-hidden="true" className="mt-0.5 font-mono text-title leading-none text-accent-text">
                  {s.icon}
                </span>
                <div>
                  <div className="mb-1 text-label font-medium text-text">{s.title}</div>
                  <div className="text-label leading-relaxed text-text-secondary">{s.desc}</div>
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
    <div className="p-5">
      <div className="mb-3 text-micro font-medium uppercase tracking-widest text-text-tertiary">AI Summary</div>
      <p className="m-0 text-label leading-relaxed text-text-secondary">
        {AUDIT_SUMMARY_EXAMPLE.map((part, i) =>
          typeof part === "string" ? (
            part
          ) : (
            <span key={i} className="font-mono">
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
    <div className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-surface2 px-5 py-3">
        <span className="text-micro font-medium uppercase tracking-widest text-text-tertiary">Audit history</span>
        <span className="font-mono text-micro text-accent-text">Monthly auto-run on</span>
      </div>
      <ul className="m-0 list-none divide-y divide-border p-0">
        {AUDIT_HISTORY_EXAMPLE.map((run) => (
          <li key={run.date} className="flex items-center justify-between gap-4 px-5 py-3">
            <span className="font-mono text-label text-text-secondary">{run.date}</span>
            <span className="text-label text-text-tertiary">{run.summary}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
