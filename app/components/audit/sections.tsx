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
import { anyAbove, formatTotals, SCOPE_UNREAD, type AuditRunView } from "~/lib/audit/render";
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
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";
import { plural } from "@drdustinedwards/site-helpers/text";
import { percent } from "capsomer/behavior/meter";

// The audit's render sections, shared by the live /audit/results and a saved run at /audit/results/:id.
// ONE LINE PER CURRENCY: each money figure is its totals per currency, stacked as /billing stacks its totals.
// THE NULL: every figure is number | null and says "could not be read" rather than a zero, so a failed Stripe read never reads as a merchant with no disputes.
// THE RECOVERABLE ESTIMATE is a fixed share (30%) of the failed invoices with its count-up; the line under the figure names it as an assumption and quotes no outside range, which would need a sourced page and date (CLAUDE.md hard rule 1).
// Not rendered: "Platform median" churn figures, which have no source and no Foxhound ledger behind them.

/** The call-to-action state. Every Foxhound account has Recovery and Disputes (app/lib/nav/manifest.ts), so a signed-in merchant is always "active". */
export type CtaState = "unauthenticated" | "active";

type Disputes = NonNullable<AuditRunView["disputes"]>;

/** Any open, forfeited, won or lost dispute. */
function hasDisputeSignal(data: Disputes): boolean {
  return (
    data.open.count > 0 ||
    data.acceptedWithoutFighting.count > 0 ||
    data.historical.won > 0 ||
    data.historical.lost > 0
  );
}

/** Whether a page renders the disputes section: off when every dispute figure is zero. A read that failed is not a zero, so the section stays and says it could not be read. */
export function showDisputesSection(run: AuditRunView): boolean {
  return run.disputes === null || hasDisputeSignal(run.disputes);
}

/** The one treatment for a scope that was not read, named so a merchant
 *  knows which figure is missing. */
function Unread({ label }: { label: string }) {
  return (
    <div className="fh-auditsec-block">
      <div className="fh-small fh-text">{label}</div>
      <p className="fh-auditsec-text fh-tiny fh-quiet">{SCOPE_UNREAD}</p>
    </div>
  );
}

function NoneDetected() {
  return <p className="fh-auditsec-text-2 fh-small fh-faint">None detected in this period.</p>;
}

/** One line per currency, stacked, each an element of its own. */
function Lines({ lines }: { lines: readonly string[] }) {
  if (lines.length === 1) return <>{lines[0]}</>;
  return (
    <span className="fh-auditsec-col">
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
        {secondary ? <div className="fh-auditsec-text fh-tiny fh-faint">{secondary}</div> : null}
      </div>
      <div className={`fh-nowrap fh-mono fh-body fh-semibold ${primaryClassName}`}>
        {typeof primary === "string" ? primary : <Lines lines={primary} />}
      </div>
    </div>
  );
}

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
    <div className="fh-auditsec-block-2">
      <div className="fh-auditsec-block-3 fh-tiny fh-quiet fh-caps">{label}</div>
      {value.map((line) => (
        <div key={line} className={`fh-mono fh-display fh-bold ${valueClassName}`}>
          {line}
        </div>
      ))}
    </div>
  );
}

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

function DisputesCta({ state }: { state: CtaState }) {
  if (state === "active") {
    return <ButtonLink to="/disputes/dashboard">View Disputes dashboard</ButtonLink>;
  }
  return (
    <div className="cap-stack" data-gap="4">
      {/* Truthfulness fix: the fee is capped per dispute (PRICING.md), which
          Recova's line left out; /billing says the same. */}
      <p className="fh-small fh-soft">
        Disputes is free until we win. You pay {DISPUTE_FEE_PERCENT}% of disputes we win, capped at{" "}
        {formatMoneyShort(DISPUTE_FEE_CAP_CENTS, "usd")} per dispute.
      </p>
      <div>
        <ButtonLink to="/connect" variant="primary">
          Enable Disputes
        </ButtonLink>
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
    <div className="fh-auditsec-text-2">
      <Panel title="Disputes unmanaged" footer={<DisputesCta state={ctaState} />}>
        {data === null ? (
          <Unread label="Disputes" />
        ) : (
          <DisputeFigures data={data} cur={cur} foxhoundWinRate={foxhoundWinRate} />
        )}
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
  const winRatePct = totalHistorical > 0 ? percent(historical.won, totalHistorical) : null;

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
        <div className="fh-auditsec-block-5 fh-small fh-soft">
          Foxhound win rate:{" "}
          <span
            className={`fh-mono fh-medium ${
              foxhoundWinRate >= 70
                ? "fh-success"
                : foxhoundWinRate >= 50
                  ? "fh-caution"
                  : "fh-error"
            }`}
          >
            {foxhoundWinRate}%
          </span>
          {winRatePct !== null ? (
            <span className="fh-quiet"> vs your historical {winRatePct}%</span>
          ) : null}
        </div>
      ) : null}

      {anyAbove(accepted.totals) ? (
        <div className="fh-auditsec-block-10">
          <Headline
            label="Revenue left on the table"
            value={formatTotals(accepted.totals, cur)}
            valueClassName="fh-red"
          />
          {/* Truthfulness fix: Recova's line says it "submits structured
              evidence automatically". Foxhound builds the evidence on its own
              and the merchant approves it before it is sent. */}
          <p className="fh-tiny fh-faint">
            Disputes lost without evidence. You approve Foxhound's evidence before it is submitted.
          </p>
        </div>
      ) : null}
    </>
  );
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
