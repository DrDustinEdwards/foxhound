import { ButtonLink } from "capsomer/react/link";
import { Panel } from "capsomer/react/panel";
import { plural } from "@drdustinedwards/site-helpers/text";
import { percent } from "capsomer/behavior/meter";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";
import { anyAbove, formatTotals, type AuditRunView } from "~/lib/audit/render";
import { DISPUTE_FEE_PERCENT } from "~/lib/billing/page";
import { DISPUTE_FEE_CAP_CENTS } from "~/lib/constants";
import { Headline, StatRow, Unread, type CtaState } from "~/components/audit/section-parts";

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

function DisputesCta({ state }: { state: CtaState }) {
  if (state === "active") {
    return <ButtonLink to="/disputes/dashboard">View Disputes dashboard</ButtonLink>;
  }
  return (
    <div className="cap-stack" data-gap="4">
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
          <p className="fh-tiny fh-quiet">
            Disputes lost without evidence. You approve Foxhound's evidence before it is submitted.
          </p>
        </div>
      ) : null}
    </>
  );
}
