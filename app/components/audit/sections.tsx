import { useCountUp } from "capsomer/react/count-up";
import { ButtonLink } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { ChartFrame } from "capsomer/react/chart-frame";
import { Panel } from "capsomer/react/panel";
import "capsomer/banner.css";
import "capsomer/count-up.css";
import "capsomer/button.css";
import { formatBps } from "capsomer/behavior/format";
import "capsomer/panel.css";
import "~/components/charts.css";
import {
  Lines,
  NoneDetected,
  Headline,
  StatRow,
  Unread,
  type CtaState,
} from "~/components/audit/section-parts";
import { anyAbove, formatTotals, type AuditRunView } from "~/lib/audit/render";
import type { MoneyTotals } from "~/lib/audit/types";
import { drawExpiringCardsTimeline, expiringCardsMonths } from "~/lib/audit/timeline";
import { RECOVERY_FEE_PERCENT } from "~/lib/billing/page";
import {
  AUDIT_RECOVERY_ESTIMATE_PCT,
  CAU_EVENT_RETENTION_DAYS,
  type DeclineCategory,
} from "~/lib/constants";
import { recoveryRateClassName } from "~/lib/dashboard/recovery-rate";
import { plural } from "@drdustinedwards/site-helpers/text";

// The audit's render sections, shared by the live /audit/results and a saved run at /audit/results/:id.
// ONE LINE PER CURRENCY: each money figure is its totals per currency, stacked as /billing stacks its totals.
// THE NULL: every figure is number | null and says "could not be read" rather than a zero, so a failed Stripe read never reads as a merchant with no disputes.
// THE RECOVERABLE ESTIMATE is a fixed share (30%) of the failed invoices with its count-up; the line under the figure names it as an assumption and quotes no outside range, which would need a sourced page and date (CLAUDE.md, Launch).
// Not rendered: "Platform median" churn figures, which have no source and no Foxhound ledger behind them.

/** A labeled card holding one paragraph. Renders nothing when there is no summary. Shared with /audit/dashboard. */
export function AuditSummary({ summary }: { summary: string | null }) {
  if (!summary) return null;
  return (
    <div className="fh-auditsec-text-2">
      <Panel title="AI Summary">
        <p className="fh-body fh-relaxed fh-text">{summary}</p>
      </Panel>
    </div>
  );
}

/** The four breakdown rows, then the two categories Foxhound's classifier adds, each with its own row so the rows sum to the total. Typed on DeclineCategory, so a seventh category cannot be left out. */
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
    <div className="fh-auditsec-block-4">
      <div className="fh-tiny fh-soft">{summary}</div>
      {cardUpdater?.advisory ? (
        <div className="fh-auditsec-block-5">
          <Banner tone="info">{cardUpdater.advisory}</Banner>
        </div>
      ) : null}
    </div>
  );
}

/** Up to four months of cards expiring, the peak month marked. Drawn by Enarratio. */
function ExpiringCardsTimeline({ expiresByMonth }: { expiresByMonth: Record<string, number> }) {
  const months = expiringCardsMonths(expiresByMonth);
  if (months.length === 0) return null;
  return (
    <div className="fh-auditsec-block-6">
      <ChartFrame draw={(width, fit) => drawExpiringCardsTimeline(months, width, fit)} />
    </div>
  );
}

function RecoveryCta({ state }: { state: CtaState }) {
  if (state === "unauthenticated") {
    return (
      <div className="cap-stack" data-gap="4">
        <p className="fh-small fh-soft">
          Recovery is free until we recover something. You pay {RECOVERY_FEE_PERCENT}% of what we
          recover.
        </p>
        <div>
          <ButtonLink to="/connect" variant="primary">
            Connect Stripe to start
          </ButtonLink>
        </div>
      </div>
    );
  }
  return <ButtonLink to="/recovery/dashboard">View Recovery dashboard</ButtonLink>;
}

export function AuditRecoverySection({
  run,
  ctaState,
  activeSequences = null,
}: {
  run: AuditRunView;
  ctaState: CtaState;
  /** A saved run only: failed payments in an active sequence for this account now. Null on the live page. */
  activeSequences?: number | null;
}) {
  const cur = run.currency;
  const failed = run.failedInvoices;
  const expiring = run.expiringCards;
  const pastDue = run.pastDueSubscriptions;

  // A scope that was not read is not "none": it is shown as unread in its own place.
  const anyUnread = failed === null || expiring === null || pastDue === null;
  const anyData =
    (failed?.count ?? 0) > 0 || (expiring?.count ?? 0) > 0 || (pastDue?.count ?? 0) > 0;

  return (
    <div className="fh-auditsec-text-2">
      <Panel title="Revenue leaking now" footer={<RecoveryCta state={ctaState} />}>
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
              <div className="fh-auditsec-block-7">
                <ButtonLink to="/recovery/payments?status=active" variant="link" size="sm">
                  {activeSequences} {activeSequences === 1 ? "is" : "are"} in active recovery
                  sequences
                  <span aria-hidden="true"> →</span>
                </ButtonLink>
              </div>
            ) : null}

            {failed !== null && failed.count > 0 ? (
              <div className="fh-auditsec-block-8">
                {BREAKDOWN_ORDER.map((key) => (
                  <div key={key} className="fh-auditsec-row-2 fh-tiny">
                    <span className="fh-quiet">{BREAKDOWN_ROWS[key]}</span>
                    <span className="fh-nowrap fh-mono fh-soft">
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

            {failed !== null ? (
              <RecoverableEstimate totals={recoverableTotals(failed.totals)} currency={cur} />
            ) : null}
          </>
        )}
      </Panel>
    </div>
  );
}

/** The figure counts up from zero over 600ms (Capsomer's count-up). The server renders the final figure. */
function RecoverableEstimate({ totals, currency }: { totals: MoneyTotals; currency: string }) {
  // Keyed on the figures, not the array, so a parent re-render does not
  // restart the count.
  const key = totals.map((t) => `${t.currency}:${t.cents}`).join(",");
  const progress = useCountUp(key, anyAbove(totals));
  const shown = totals.map((t) => ({
    currency: t.currency,
    cents: Math.round(t.cents * progress),
  }));
  return (
    <>
      <div className="fh-auditsec-block-9" />
      <div className="fh-auditsec-block-2">
        <div className="fh-mk-kicker fh-tiny fh-quiet">Recoverable estimate</div>
        <div className="fh-mono fh-title fh-bold fh-success">
          <Lines lines={formatTotals(shown, currency)} />
        </div>
      </div>
      <p className="fh-tiny fh-faint">
        Assumes {AUDIT_RECOVERY_ESTIMATE_PCT}% of failed invoices are recovered. This is an
        assumption, not a measured rate.
      </p>
    </>
  );
}

/** The estimate's totals: the assumed share of each currency's failed invoices. */
function recoverableTotals(failed: MoneyTotals): MoneyTotals {
  return failed.map((t) => ({
    currency: t.currency,
    cents: Math.round((t.cents * AUDIT_RECOVERY_ESTIMATE_PCT) / 100),
  }));
}

export function AuditHealthSection({
  run,
  recoveryRatePct = null,
}: {
  run: AuditRunView;
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
    <div className="fh-auditsec-text-2">
      <Panel title="Business snapshot">
        {health === null ? (
          <Unread label="Subscriptions" />
        ) : !anyData ? (
          <NoneDetected />
        ) : (
          <>
            <div className="fh-auditsec-grid">
              <Headline
                label="MRR"
                value={formatTotals(health.mrr, cur)}
                valueClassName="fh-text"
              />
              <Headline
                label="ARR"
                value={formatTotals(health.arr, cur)}
                valueClassName="fh-text"
              />
            </div>
            <StatRow
              label="Active subscriptions"
              primary={String(health.activeSubscriptionsCount)}
            />
            <StatRow
              label="Involuntary churn rate"
              primary={formatBps(health.involuntaryChurnRateBps, { digits: 1 })}
            />
            <StatRow
              label="Voluntary churn rate"
              primary={formatBps(health.voluntaryChurnRateBps, { digits: 1 })}
            />
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
