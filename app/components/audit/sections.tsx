import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Banner } from "capsomer/react/banner";
import { Panel } from "capsomer/react/panel";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/panel.css";

import { EnarratioFigure } from "~/components/enarratio-figure";
import {
  anyAbove,
  formatBps,
  formatTotals,
  SCOPE_UNREAD,
  type AuditRunView,
} from "~/lib/audit/render";
import type { MoneyTotals } from "~/lib/audit/engine";
import { drawExpiringCardsTimeline, expiringCardsMonths } from "~/lib/audit/timeline";
import { DISPUTE_FEE_PERCENT, RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import {
  AUDIT_RECOVERY_ESTIMATE_PCT,
  CAU_EVENT_RETENTION_DAYS,
  DISPUTE_FEE_CAP_CENTS,
  type DeclineCategory,
} from "~/lib/constants";
import { recoveryRateClassName } from "~/lib/dashboard/recovery-rate";
import { formatMoneyShort } from "~/lib/money-format";

// The audit's render sections, shared by BOTH surfaces that show a run: the
// live /audit/results and a saved run at /audit/results/:id. Recova shares its
// four components between its two pages the same way
// (components/audit/AuditAISummary 5ba213df, AuditRecoverySection ab6ec2c5,
// AuditDisputesSection 6db9c3bc, AuditHealthSection 17828ab5, read whole at
// HEAD for J63, job_66a3ffa02214, rows U3 and U4).
//
// RECOVA IS THE SPEC for what each section says and in what order: every
// heading, line, row, empty state, chart and call to action below is Recova's,
// except where a comment names the difference and why. The look is Capsomer
// 0.9.0's (Q10 to Q12): each section is a Panel with its description, the
// calls to action sit in the panel's footer as Capsomer buttons, the Card
// Updater advisory is a Capsomer banner, and the expiring-cards timeline is an
// Enarratio chart (Q1). Amber throughout. Text is on the five sizes
// (RULES.md 5.2). What Recova's look still needs (the summary's accent rail,
// the mono figures, the stat-row layout) is listed for Capsomer's per-site
// layer, capsomer job_ec5ec0754626, in the J63 pull request; no Foxhound class
// sits on a Capsomer element.
//
// ONE LINE PER CURRENCY. Each money figure is its totals per currency
// (RULES.md 3.20), stacked one under another as /billing stacks its totals.
// Recova added the currencies into one number under the first one's label;
// Dustin approved the lines on 2026-10-25 (parity/APPROVED-DIFFERENCES.md).
// A single-currency run shows one line, as before.
//
// THE NULL. Every figure is `number | null` and says "could not be read"
// rather than printing a zero (365 binding 2). Recova's `?? 0` is where a
// failed Stripe read becomes a merchant with no disputes.
//
// THE RECOVERABLE ESTIMATE is Recova's, a fixed share of the failed invoices
// with its count-up, restored on Dustin's ruling of 2026-10-29 ("30%, with its
// basis shown"). Truthfulness fix: Recova called the 30% a "platform average
// recovery rate", which it never measured, so the line under the figure names
// it as an assumption and gives the published range.
//
// WHAT IS NOT RENDERED, and why. Recova's two "Platform median" churn figures
// are statistics with no source and no Foxhound ledger behind them (RULES.md
// 2.3), so they stay out.

/** The call-to-action state. Recova has a third, "inactive", for an account
 *  without the product; every Foxhound account has Recovery and Disputes
 *  (app/lib/nav/manifest.ts), so a signed-in merchant is always "active". */
export type CtaState = "unauthenticated" | "active";

type Disputes = NonNullable<AuditRunView["disputes"]>;

/** Recova's hasDisputeSignal: any open, forfeited, won or lost dispute. */
function hasDisputeSignal(data: Disputes): boolean {
  return (
    data.open.count > 0 ||
    data.acceptedWithoutFighting.count > 0 ||
    data.historical.won > 0 ||
    data.historical.lost > 0
  );
}

/** Whether a page renders the disputes section. Recova leaves it off when
 *  every dispute figure is zero. A read that failed is not a zero, so the
 *  section stays and says it could not be read. */
export function showDisputesSection(run: AuditRunView): boolean {
  return run.disputes === null || hasDisputeSignal(run.disputes);
}

/** The one treatment for a scope that was not read, named so a merchant
 *  knows which figure is missing (J63 review round 1). */
function Unread({ label }: { label: string }) {
  return (
    <div className="py-2">
      <div className="text-label text-text">{label}</div>
      <p className="m-0 mt-0.5 text-micro text-text-tertiary">{SCOPE_UNREAD}</p>
    </div>
  );
}

function NoneDetected() {
  return <p className="m-0 mb-5 text-label text-text-subtle">None detected in this period.</p>;
}

/** One line per currency, stacked, each an element of its own. A single
 *  line renders as the bare text it always was. */
function Lines({ lines }: { lines: readonly string[] }) {
  if (lines.length === 1) return <>{lines[0]}</>;
  return (
    <span className="flex flex-col items-end">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

function StatRow({
  label,
  primary,
  secondary,
  primaryClassName = "text-text",
}: {
  label: string;
  primary: string | readonly string[];
  secondary?: string;
  primaryClassName?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div>
        <div className="text-label text-text">{label}</div>
        {secondary ? <div className="mt-0.5 text-micro text-text-subtle">{secondary}</div> : null}
      </div>
      <div className={`whitespace-nowrap font-mono text-body font-semibold ${primaryClassName}`}>
        {typeof primary === "string" ? primary : <Lines lines={primary} />}
      </div>
    </div>
  );
}

/** Recova's large figure under a rule: a small uppercase label over a mono
 *  number ("Revenue left on the table"). */
function Headline({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: readonly string[];
  valueClassName: string;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-micro uppercase tracking-wide text-text-tertiary">{label}</div>
      {value.map((line) => (
        <div key={line} className={`font-mono text-display font-bold ${valueClassName}`}>
          {line}
        </div>
      ))}
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Recova's AuditAISummary (5ba213df): a labeled card holding one paragraph.
 *  Renders nothing when there is no summary. Shared with /audit/dashboard. */
export function AuditSummary({ summary }: { summary: string | null }) {
  if (!summary) return null;
  return (
    <div className="mb-5">
      <Panel title="AI Summary">
        <p className="m-0 text-body leading-relaxed text-text">{summary}</p>
      </Panel>
    </div>
  );
}

// ---- Revenue leaking now --------------------------------------------------

/** Recova's four breakdown rows, in Recova's order and words, then the two
 *  categories Foxhound's classifier adds. Recova folds those two into "Soft
 *  declines"; here each keeps its own row, so the rows sum to the total
 *  (a truthfulness fix). Typed on DeclineCategory, so a seventh category
 *  cannot be left out. */
const BREAKDOWN_ROWS: Record<DeclineCategory, string> = {
  soft: "Soft declines",
  expired: "Expired cards",
  network: "Network errors",
  fraud: "Fraud flags",
  revoked: "Revoked authorizations",
  unknown: "Unclassified declines",
};
const BREAKDOWN_ORDER = Object.keys(BREAKDOWN_ROWS) as DeclineCategory[];

function CardUpdaterRow({ cardUpdater }: { cardUpdater: AuditRunView["cardUpdater"] }) {
  const days = CAU_EVENT_RETENTION_DAYS;
  const summary =
    cardUpdater === null
      ? `Card Updater: data unavailable for the last ${days} days.`
      : `Card Updater: ${plural(cardUpdater.eventsInWindow, "card")} auto-updated in the last ${days} days (${plural(cardUpdater.expiredCardDeclinesInWindow, "expired-card decline")} in the same window).`;
  return (
    <div className="mb-4 ml-5 mt-3">
      <div className="text-micro text-text-secondary">{summary}</div>
      {cardUpdater?.advisory ? (
        <div className="mt-2">
          <Banner tone="info">{cardUpdater.advisory}</Banner>
        </div>
      ) : null}
    </div>
  );
}

/** Recova's ExpiringCardsTimeline (33537a84): up to four months of cards
 *  expiring, the peak month marked. Drawn by Enarratio (Q1). */
function ExpiringCardsTimeline({ expiresByMonth }: { expiresByMonth: Record<string, number> }) {
  const months = expiringCardsMonths(expiresByMonth);
  if (months.length === 0) return null;
  return (
    // min-w-0: the panel body is a grid, and without it the chart's first
    // 640px draw sets the column's width, pushing every figure in the panel
    // past a phone's edge before the redraw can measure.
    <div className="mt-4 min-w-0">
      <EnarratioFigure draw={(width) => drawExpiringCardsTimeline(months, width)} initialWidth={640} />
    </div>
  );
}

function RecoveryCta({ state }: { state: CtaState }) {
  if (state === "unauthenticated") {
    return (
      <div className="flex flex-col gap-3">
        <p className="m-0 text-label text-text-secondary">
          Recovery is free until we recover something. You pay {RECOVERY_FEE_PERCENT}% of what we recover.
        </p>
        <div>
          <Link to="/connect" className="cap-btn" data-variant="primary">
            Connect Stripe to start
          </Link>
        </div>
      </div>
    );
  }
  return (
    <Link to="/recovery/dashboard" className="cap-btn">
      View Recovery dashboard
    </Link>
  );
}

export function AuditRecoverySection({
  run,
  ctaState,
  activeSequences = null,
}: {
  run: AuditRunView;
  ctaState: CtaState;
  /** A saved run only: failed payments in an active sequence for this account
   *  now. Null on the live page, as in Recova. */
  activeSequences?: number | null;
}) {
  const cur = run.currency;
  const failed = run.failedInvoices;
  const expiring = run.expiringCards;
  const pastDue = run.pastDueSubscriptions;

  // Recova's "any recovery data". A scope that was not read is not "none":
  // it is shown as unread in its own place.
  const anyUnread = failed === null || expiring === null || pastDue === null;
  const anyData =
    (failed?.count ?? 0) > 0 || (expiring?.count ?? 0) > 0 || (pastDue?.count ?? 0) > 0;

  return (
    <div className="mb-5">
      <Panel
        title="Revenue leaking now"
        description="What your Stripe account is losing or about to lose."
        footer={<RecoveryCta state={ctaState} />}
      >
        {!anyData && !anyUnread ? (
          <NoneDetected />
        ) : (
          <>
            {failed === null ? (
              <Unread label="Failed invoices" />
            ) : (
              <StatRow
                label="Failed invoices"
                primary={formatTotals(failed.totals, cur)}
                secondary={plural(failed.count, "invoice")}
              />
            )}

            {activeSequences !== null && activeSequences > 0 ? (
              <div className="ml-5 mt-1">
                <Link
                  to="/recovery/payments?status=active"
                  className="cap-btn"
                  data-variant="link"
                  data-size="sm"
                >
                  {activeSequences} {activeSequences === 1 ? "is" : "are"} in active recovery sequences
                  <span aria-hidden="true"> →</span>
                </Link>
              </div>
            ) : null}

            {failed !== null && failed.count > 0 ? (
              <div className="mb-4 ml-5 mt-3 space-y-2">
                {BREAKDOWN_ORDER.map((key) => (
                  <div key={key} className="flex items-start justify-between text-micro">
                    <span className="text-text-tertiary">{BREAKDOWN_ROWS[key]}</span>
                    <span className="whitespace-nowrap font-mono text-text-secondary">
                      <Lines lines={formatTotals(failed.byCategory[key] ?? [], cur)} />
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            <CardUpdaterRow cardUpdater={run.cardUpdater} />

            {expiring === null ? (
              <Unread label="Expiring cards (through next month)" />
            ) : (
              <>
                {/* Truthfulness fix: Recova labels this "(next 30 days)", but the
                    engine counts cards already expired and those expiring this
                    month or next (app/lib/audit/engine.ts computeExpiringCards). */}
                <StatRow
                  label="Expiring cards (through next month)"
                  primary={formatTotals(expiring.mrrAtRisk, cur)}
                  secondary={`${plural(expiring.count, "card")} at risk`}
                />
                <ExpiringCardsTimeline expiresByMonth={expiring.expiresByMonth} />
              </>
            )}

            {pastDue === null ? (
              <Unread label="Past-due subscriptions" />
            ) : (
              <StatRow
                label="Past-due subscriptions"
                primary={formatTotals(pastDue.totals, cur)}
                secondary={plural(pastDue.count, "subscription")}
              />
            )}

            {failed !== null ? <RecoverableEstimate totals={recoverableTotals(failed.totals)} currency={cur} /> : null}
          </>
        )}
      </Panel>
    </div>
  );
}

/** Recova's RecoverableCountUp: the figure counts up from zero over 600ms
 *  with a cubic ease. The server renders the final figure, so the page reads
 *  right before scripts load, and a reader who asks for reduced motion sees
 *  it still. */
function RecoverableEstimate({ totals, currency }: { totals: MoneyTotals; currency: string }) {
  const [progress, setProgress] = useState(1);
  // Keyed on the figures, not the array, so a parent re-render does not
  // restart the count.
  const key = totals.map((t) => `${t.currency}:${t.cents}`).join(",");
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (!anyAbove(totals)) return;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - start) / 600, 1);
      setProgress(1 - Math.pow(1 - t, 3));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the figures
  }, [key]);
  const shown = totals.map((t) => ({ currency: t.currency, cents: Math.round(t.cents * progress) }));
  return (
    <>
      <div className="my-5 border-t border-border" />
      <div className="mb-2">
        <div className="mb-1 text-micro uppercase tracking-[0.06em] text-text-tertiary">Recoverable estimate</div>
        <div className="font-mono text-title font-bold text-success-text">
          <Lines lines={formatTotals(shown, currency)} />
        </div>
      </div>
      <p className="m-0 text-micro text-text-subtle">
        Assumes {AUDIT_RECOVERY_ESTIMATE_PCT}% of failed invoices are recovered. Full recovery programs
        typically recover 30 to 70%.
      </p>
    </>
  );
}

/** The estimate's totals: the assumed share of each currency's failed invoices. */
function recoverableTotals(failed: MoneyTotals): MoneyTotals {
  return failed.map((t) => ({ currency: t.currency, cents: Math.round((t.cents * AUDIT_RECOVERY_ESTIMATE_PCT) / 100) }));
}

// ---- Disputes unmanaged -----------------------------------------------------

function DisputesCta({ state }: { state: CtaState }) {
  if (state === "active") {
    return (
      <Link to="/disputes/dashboard" className="cap-btn">
        View Disputes dashboard
      </Link>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {/* Truthfulness fix: the fee is capped per dispute (PRICING.md), which
          Recova's line left out; /billing says the same. */}
      <p className="m-0 text-label text-text-secondary">
        Disputes is free until we win. You pay {DISPUTE_FEE_PERCENT}% of disputes we win, capped at{" "}
        {formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")} per dispute.
      </p>
      <div>
        <Link to="/connect" className="cap-btn" data-variant="primary">
          Enable Disputes
        </Link>
      </div>
    </div>
  );
}

export function AuditDisputesSection({
  run,
  ctaState,
  foxhoundWinRate = null,
}: {
  run: AuditRunView;
  ctaState: CtaState;
  /** A saved run only: the share of disputes Foxhound submitted for this
   *  account that were won. Null when Foxhound has resolved none. */
  foxhoundWinRate?: number | null;
}) {
  const cur = run.currency;
  const data = run.disputes;
  return (
    <div className="mb-5">
      <Panel
        title="Disputes unmanaged"
        description="Where responses were skipped or evidence was thin."
        footer={<DisputesCta state={ctaState} />}
      >
        {data === null ? <Unread label="Disputes" /> : <DisputeFigures data={data} cur={cur} foxhoundWinRate={foxhoundWinRate} />}
      </Panel>
    </div>
  );
}

function DisputeFigures({
  data,
  cur,
  foxhoundWinRate,
}: {
  data: Disputes;
  cur: string;
  foxhoundWinRate: number | null;
}) {
  const { open, acceptedWithoutFighting: accepted, historical } = data;
  const totalHistorical = historical.won + historical.lost;
  const winRatePct = totalHistorical > 0 ? Math.round((historical.won / totalHistorical) * 100) : null;

  return (
    <>
      <StatRow
        label="Open disputes"
        primary={formatTotals(open.totals, cur)}
        secondary={`${open.count} awaiting response`}
      />
      <StatRow
        label="Accepted without fighting"
        primary={formatTotals(accepted.totals, cur)}
        secondary={
          accepted.count === 0
            ? "No disputes forfeited by default"
            : `${plural(accepted.count, "dispute")} lost with no evidence submitted`
        }
      />
      <StatRow
        label="Historical record"
        primary={totalHistorical > 0 ? `${historical.won} won, ${historical.lost} lost` : "None"}
        secondary={winRatePct === null ? "No closed disputes yet" : `${winRatePct}% win rate`}
      />

      {/* Recova's "Recova win rate", from Foxhound's own records: disputes
          whose evidence Foxhound submitted, won over resolved. Recova's bands
          are 70 and 50. The middle band takes the caution color, the same
          rule as the recovery rate's middle band (recoveryRateClassName):
          status colors are not accents, so the one-accent rule leaves them
          alone. */}
      {foxhoundWinRate !== null ? (
        <div className="mt-2 text-label text-text-secondary">
          Foxhound win rate:{" "}
          <span
            className={`font-mono font-medium ${
              foxhoundWinRate >= 70
                ? "text-success-text"
                : foxhoundWinRate >= 50
                  ? "text-caution"
                  : "text-error-text"
            }`}
          >
            {foxhoundWinRate}%
          </span>
          {winRatePct !== null ? (
            <span className="text-text-tertiary"> vs your historical {winRatePct}%</span>
          ) : null}
        </div>
      ) : null}

      {anyAbove(accepted.totals) ? (
        <div className="mt-5 border-t border-border pt-5">
          <Headline
            label="Revenue left on the table"
            value={formatTotals(accepted.totals, cur)}
            valueClassName="text-red"
          />
          {/* Truthfulness fix: Recova's line says it "submits structured
              evidence automatically". Foxhound builds the evidence on its own
              and the merchant approves it before it is sent (RULES.md 5.6). */}
          <p className="m-0 text-micro text-text-subtle">
            Disputes you lost without submitting evidence. Foxhound builds structured evidence automatically,
            and you approve it before it is submitted.
          </p>
        </div>
      ) : null}
    </>
  );
}

// ---- Business snapshot -------------------------------------------------------

export function AuditHealthSection({
  run,
  when,
  recoveryRatePct = null,
}: {
  run: AuditRunView;
  /** "live" on /audit/results, "stored" on a saved run. Recova says "right
   *  now" on both; on a saved run that is not true, so the line says when. */
  when: "live" | "stored";
  /** A saved run only: the account's lifetime recovery rate now. Null when
   *  nothing has failed yet, which is not a 0%. */
  recoveryRatePct?: number | null;
}) {
  const cur = run.currency;
  const health = run.health;
  const anyData =
    health !== null &&
    (anyAbove(health.mrr) ||
      anyAbove(health.arr) ||
      health.activeSubscriptionsCount > 0 ||
      health.voluntaryChurnRateBps > 0 ||
      health.involuntaryChurnRateBps > 0);

  return (
    <div className="mb-5">
      <Panel
        title="Business snapshot"
        description={
          when === "live"
            ? "Your recurring-revenue picture right now."
            : "Your recurring-revenue picture at the time of this run."
        }
        footer={
          // Truthfulness fix: Recova's line adds "and forecasting", which
          // Foxhound's Intelligence does not have. Cohort analysis it does
          // (app/lib/intelligence/mrr.ts buildCohortBreakdown), so that stays.
          <p className="m-0 text-micro text-text-subtle">
            Full trend history and cohort analysis available in Intelligence.
          </p>
        }
      >
        {health === null ? (
          <Unread label="Subscriptions" />
        ) : !anyData ? (
          <NoneDetected />
        ) : (
          <>
            <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
              <Headline label="MRR" value={formatTotals(health.mrr, cur)} valueClassName="text-text" />
              <Headline label="ARR" value={formatTotals(health.arr, cur)} valueClassName="text-text" />
            </div>
            <StatRow label="Active subscriptions" primary={String(health.activeSubscriptionsCount)} />
            <StatRow label="Involuntary churn rate" primary={formatBps(health.involuntaryChurnRateBps)} />
            <StatRow label="Voluntary churn rate" primary={formatBps(health.voluntaryChurnRateBps)} />
            {recoveryRatePct !== null ? (
              <StatRow
                label="Recovery rate"
                secondary="Lifetime recovered vs. failed"
                primary={`${recoveryRatePct}%`}
                primaryClassName={recoveryRateClassName(recoveryRatePct)}
              />
            ) : null}
          </>
        )}
      </Panel>
    </div>
  );
}
