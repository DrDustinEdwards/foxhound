import { Link } from "react-router";

import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { getAuditRun } from "~/lib/audit/persist.server";
import {
  formatBps,
  formatCents,
  SCOPE_UNREAD,
  toStoredAuditRun,
  type StoredAuditRun,
} from "~/lib/audit/render";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { cloudflareContext } from "~/lib/cloudflare-context";

import type { Route } from "./+types/run";

// Legacy's `/audit/results/[id]` (blob `a0dbf6ef`, 11,127 bytes), phase (e).
//
// LEGACY'S SHARE LINK IS NOT A SHARE LINK, and that is the walk's finding on the
// question the brief asked. Its page carries a "Copy link" button beside the
// heading, and the page it copies begins `if (!user) redirect('/audit')` and
// then filters `account_id`. So the link works for a teammate on the same
// account and refuses everyone else. Nothing about a stored run was ever
// publicly readable, and Foxhound keeps that: this loader reads through
// `getAuditRun`, which pins the account in the predicate. The copy button is not
// ported, because a control labelled Copy link that produces a link only your
// own account can open is an affordance that lies about what it does.
//
// EVERY FIGURE IS number OR null, NEVER COALESCED. Legacy maps this row with
// `?? 0` on every column, so a run whose disputes call failed renders as a
// merchant with no open disputes. 362 ruling 2 gave the engine a per-scope
// status, 364 stored it as the NULL, and this is where it has to survive or the
// other two were decoration.
//
// THREE THINGS LEGACY RENDERS ARE NOT PORTED, each already ruled NOT PORTABLE:
// its "Recoverable estimate" built from AUDIT_RECOVERY_ESTIMATE_PCT, its two
// "Platform median" churn figures, and its recovery-rate colour bands. All
// three are platform numbers Foxhound has no history for.

export function meta() {
  return [{ title: "Audit run - Foxhound" }];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const row = await getAuditRun(getDb(env), auth.membership.accountId, params.id);
  if (!row) throw new Response("Not Found", { status: 404 });
  return { run: toStoredAuditRun(row) };
}

function formatDate(value: Date): string {
  return value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function Section({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) {
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

function StatRow({ label, primary, secondary }: { label: string; primary: string; secondary?: string }) {
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

function Recovery({ run }: { run: StoredAuditRun }) {
  const cur = run.currency;
  return (
    <Section title="Revenue leaking now" blurb="What this account was losing or about to lose.">
      {run.failedInvoices === null ? (
        <Unread />
      ) : (
        <>
          <StatRow
            label="Failed invoices"
            primary={formatCents(run.failedInvoices.totalCents, cur)}
            secondary={`${run.failedInvoices.count} invoice${run.failedInvoices.count === 1 ? "" : "s"}`}
          />
          {/* SIX CATEGORIES, derived from the label map. Legacy hardcodes four
              rows and would silently drop a revoked or unclassified decline's
              money out of the breakdown while keeping it in the total. */}
          <div className="mb-4 ml-5 mt-3 space-y-2">
            {Object.entries(DECLINE_CATEGORY_LABELS).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between text-micro">
                <span className="text-text-tertiary">{label}</span>
                <span className="font-mono text-text-secondary">
                  {formatCents(run.failedInvoices!.byCategory[key] ?? 0, cur)}
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

function Disputes({ run }: { run: StoredAuditRun }) {
  const cur = run.currency;
  return (
    <Section title="Disputes unmanaged" blurb="Where responses were skipped or evidence was thin.">
      {run.disputes === null ? (
        <Unread />
      ) : (
        <>
          <StatRow
            label="Open disputes"
            primary={formatCents(run.disputes.open.totalCents, cur)}
            secondary={`${run.disputes.open.count} awaiting response`}
          />
          <StatRow
            label="Accepted without fighting"
            primary={formatCents(run.disputes.acceptedWithoutFighting.totalCents, cur)}
            secondary={
              run.disputes.acceptedWithoutFighting.count === 0
                ? "None forfeited by default"
                : `${run.disputes.acceptedWithoutFighting.count} lost with no evidence submitted`
            }
          />
          <StatRow
            label="Historical record"
            primary={
              run.disputes.historical.won + run.disputes.historical.lost > 0
                ? `${run.disputes.historical.won} won, ${run.disputes.historical.lost} lost`
                : "None"
            }
          />
        </>
      )}
    </Section>
  );
}

function Health({ run }: { run: StoredAuditRun }) {
  const cur = run.currency;
  return (
    <Section title="Business snapshot" blurb="The recurring-revenue picture at the time of this run.">
      {run.health === null ? (
        <Unread />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <div className="mb-1 text-micro uppercase tracking-widest text-text-tertiary">MRR</div>
              <div className="font-mono text-h2 font-bold text-text">
                {formatCents(run.health.mrrCents, cur)}
              </div>
            </div>
            <div>
              <div className="mb-1 text-micro uppercase tracking-widest text-text-tertiary">ARR</div>
              <div className="font-mono text-h2 font-bold text-text">
                {formatCents(run.health.arrCents, cur)}
              </div>
            </div>
          </div>
          <StatRow
            label="Active subscriptions"
            primary={String(run.health.activeSubscriptionsCount)}
          />
          {/* NO "Platform median" LINES. Legacy prints 2.1% and 3.5% beside
              these; both are platform figures Foxhound has no history for. */}
          <StatRow
            label="Involuntary churn rate"
            primary={formatBps(run.health.involuntaryChurnRateBps)}
          />
          <StatRow
            label="Voluntary churn rate"
            primary={formatBps(run.health.voluntaryChurnRateBps)}
          />
        </>
      )}
    </Section>
  );
}

export default function AuditRunPage({ loaderData }: Route.ComponentProps) {
  const { run } = loaderData;

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-10 md:px-8">
      <section className="mb-5 rounded-xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="m-0 text-body font-semibold text-text">
              This audit was run on {formatDate(run.runAt)}.
            </h1>
            <p className="m-0 mt-1 text-label text-text-tertiary">
              It reflects the Stripe account at that point, over the {run.lookbackDays} days before
              it.
            </p>
          </div>
          <Link
            to="/audit/history"
            className="inline-block text-label text-text-tertiary no-underline hover:text-text"
          >
            Back to history
          </Link>
        </div>
      </section>

      {run.summary ? (
        <section className="mb-5 rounded-xl border border-border border-l-2 border-l-amber bg-surface p-6">
          <div className="mb-3 font-mono text-micro font-medium uppercase tracking-widest text-amber-text">
            AI Summary
          </div>
          <p className="m-0 text-item-title leading-relaxed text-text">{run.summary}</p>
        </section>
      ) : null}

      <Recovery run={run} />
      <Disputes run={run} />
      <Health run={run} />
    </div>
  );
}
