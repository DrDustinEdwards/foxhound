import {
  formatBps,
  formatCents,
  SCOPE_UNREAD,
  type AuditRunView,
} from "~/lib/audit/render";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";

// The audit's render sections, shared by BOTH surfaces that show a run.
//
// EXTRACTED IN PHASE (f), NOT WRITTEN TWICE. Phase (e) built these inside
// app/routes/app/audit/run.tsx because the stored-run page was the only reader.
// The live anonymous results page is the second, and legacy shares the same four
// components between its own two pages (components/audit/AuditAISummary,
// AuditRecoverySection, AuditDisputesSection, AuditHealthSection), so the split
// is legacy's structure as much as it is deduplication.
//
// THE REASON IT MATTERS IS THE NULL. Every figure below is `number | null` and
// says "could not be read" rather than printing a zero (365 binding 2). A second
// copy of these sections is a second place for that to be coalesced back to
// `?? 0`, and the copy that got it wrong would be the one nobody re-read.
//
// FOUR LEGACY RENDERS ARE ABSENT, each on a ruling that predates this file: the
// "Recoverable estimate" from AUDIT_RECOVERY_ESTIMATE_PCT, the two "Platform
// median" churn figures (2.1% and 3.5%), the recovery-rate colour bands, and the
// Recova win rate, which reads dispute rows Foxhound has never written.

function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 rounded-xl border border-border bg-surface p-6">
      <h2 className="m-0 mb-1 text-body font-semibold text-text">{title}</h2>
      <p className="m-0 mb-5 text-label text-text-tertiary">{blurb}</p>
      {children}
    </section>
  );
}

/** The one treatment for a scope that was not read. */
function Unread() {
  return <div className="text-label text-text-tertiary">{SCOPE_UNREAD}</div>;
}

function StatRow({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <div className="text-label text-text">{label}</div>
        {secondary ? <div className="mt-0.5 text-micro text-text-tertiary">{secondary}</div> : null}
      </div>
      <div className="whitespace-nowrap font-mono text-item-title font-semibold text-text">
        {primary}
      </div>
    </div>
  );
}

/** Legacy's AuditAISummary (blob `5ba213df`): amber left rail, mono uppercase
 *  label, one paragraph. Renders nothing when there is no summary. */
export function AuditSummary({ summary }: { summary: string | null }) {
  if (!summary) return null;
  return (
    <section className="mb-5 rounded-xl border border-border border-l-2 border-l-amber bg-surface p-6">
      <div className="mb-3 font-mono text-micro font-medium uppercase tracking-widest text-amber-text">
        AI Summary
      </div>
      <p className="m-0 text-item-title leading-relaxed text-text">{summary}</p>
    </section>
  );
}

export function AuditRecoverySection({ run }: { run: AuditRunView }) {
  const cur = run.currency;
  const failed = run.failedInvoices;
  return (
    <Section title="Revenue leaking now" blurb="What this account was losing or about to lose.">
      {failed === null ? (
        <Unread />
      ) : (
        <>
          <StatRow
            label="Failed invoices"
            primary={formatCents(failed.totalCents, cur)}
            secondary={`${failed.count} invoice${failed.count === 1 ? "" : "s"}`}
          />
          {/* SIX CATEGORIES, derived from the label map. Legacy hardcodes four
              rows and would silently drop a revoked or unclassified decline's
              money out of the breakdown while keeping it in the total. */}
          <div className="mb-4 ml-5 mt-3 space-y-2">
            {Object.entries(DECLINE_CATEGORY_LABELS).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between text-micro">
                <span className="text-text-tertiary">{label}</span>
                <span className="font-mono text-text-secondary">
                  {formatCents(failed.byCategory[key] ?? 0, cur)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {run.cardUpdater === null ? null : (
        <div className="mb-4 ml-5 mt-3">
          <div className="text-micro text-text-secondary">
            {`Card Updater: ${run.cardUpdater.eventsInWindow} card${run.cardUpdater.eventsInWindow === 1 ? "" : "s"} auto-updated in the last 30 days (${run.cardUpdater.expiredCardDeclinesInWindow} expired-card decline${run.cardUpdater.expiredCardDeclinesInWindow === 1 ? "" : "s"} in the same window).`}
          </div>
          {run.cardUpdater.advisory ? (
            <div className="mt-2 rounded-md border border-amber bg-amber-bg px-3 py-2 text-micro text-amber-text">
              {run.cardUpdater.advisory}
            </div>
          ) : null}
        </div>
      )}

      {run.expiringCards === null ? (
        <Unread />
      ) : (
        <StatRow
          label="Expiring cards"
          primary={formatCents(run.expiringCards.mrrAtRiskCents, cur)}
          secondary={`${run.expiringCards.count} card${run.expiringCards.count === 1 ? "" : "s"} at risk`}
        />
      )}

      {run.pastDueSubscriptions === null ? (
        <Unread />
      ) : (
        <StatRow
          label="Past-due subscriptions"
          primary={formatCents(run.pastDueSubscriptions.totalCents, cur)}
          secondary={`${run.pastDueSubscriptions.count} subscription${run.pastDueSubscriptions.count === 1 ? "" : "s"}, at their next cycle's value`}
        />
      )}
    </Section>
  );
}

export function AuditDisputesSection({ run }: { run: AuditRunView }) {
  const cur = run.currency;
  const disputes = run.disputes;
  return (
    <Section title="Disputes unmanaged" blurb="Where responses were skipped or evidence was thin.">
      {disputes === null ? (
        <Unread />
      ) : (
        <>
          <StatRow
            label="Open disputes"
            primary={formatCents(disputes.open.totalCents, cur)}
            secondary={`${disputes.open.count} awaiting response`}
          />
          <StatRow
            label="Accepted without fighting"
            primary={formatCents(disputes.acceptedWithoutFighting.totalCents, cur)}
            secondary={
              disputes.acceptedWithoutFighting.count === 0
                ? "None forfeited by default"
                : `${disputes.acceptedWithoutFighting.count} lost with no evidence submitted`
            }
          />
          <StatRow
            label="Historical record"
            primary={
              disputes.historical.won + disputes.historical.lost > 0
                ? `${disputes.historical.won} won, ${disputes.historical.lost} lost`
                : "None"
            }
          />
        </>
      )}
    </Section>
  );
}

export function AuditHealthSection({ run }: { run: AuditRunView }) {
  const cur = run.currency;
  const health = run.health;
  return (
    <Section
      title="Business snapshot"
      blurb="The recurring-revenue picture at the time of this run."
    >
      {health === null ? (
        <Unread />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <div className="mb-1 text-micro uppercase tracking-widest text-text-tertiary">MRR</div>
              <div className="font-mono text-h2 font-bold text-text">
                {formatCents(health.mrrCents, cur)}
              </div>
            </div>
            <div>
              <div className="mb-1 text-micro uppercase tracking-widest text-text-tertiary">ARR</div>
              <div className="font-mono text-h2 font-bold text-text">
                {formatCents(health.arrCents, cur)}
              </div>
            </div>
          </div>
          <StatRow label="Active subscriptions" primary={String(health.activeSubscriptionsCount)} />
          {/* NO "Platform median" LINES. Legacy prints 2.1% and 3.5% beside
              these; both are platform figures Foxhound has no history for. */}
          <StatRow
            label="Involuntary churn rate"
            primary={formatBps(health.involuntaryChurnRateBps)}
          />
          <StatRow label="Voluntary churn rate" primary={formatBps(health.voluntaryChurnRateBps)} />
        </>
      )}
    </Section>
  );
}
