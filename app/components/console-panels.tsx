import { Icon, iconArrowRight } from "capsomer/react/icons";
import { routerRenderLink, ButtonLink } from "capsomer/react/link";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import { StatTile } from "capsomer/react/stat-tile";
import "capsomer/button.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/stat-tile.css";
import "capsomer/status.css";

import {
  atRiskSubtext,
  formatCurrencyTotalsShort,
  lastRunPhrase,
  protectedSubtext,
} from "~/lib/dashboard/console";
import { recoveryRateBand, recoveryRateClassNameOrNull } from "~/lib/dashboard/recovery-rate";
import { formatMoneyShort } from "@dustinedwards/site-runtime/money";
import type { AttentionRow, ConsoleHero, ConsoleTiles } from "~/lib/dashboard/console.server";

// The console's three parts in Recova's order (app/(app)/console/page.tsx at
// blob 3b8a736e, with lib/console-data.tsx at 234791c4): the hero row of three
// platform figures, the four product tiles, then the needs-attention rows.
// Built from Capsomer 0.9.0's parts: the hero cards are Panels, the
// product tiles are StatTiles, the attention rows are row-list rows with a
// Pill for the product. No Foxhound CSS sits over a Capsomer component; what
// Recova's look needs beyond Capsomer's defaults (the tile icons and arrows,
// the dimmed inactive tile, the row's colored dot) waits for Capsomer's
// per-site layer and is listed in the J64 pull
// request.
//
// Pure components: every number arrives already computed from
// app/lib/dashboard/console.server.ts. Type-only imports from that module are
// erased at build, so no server code reaches the client bundle.

/** Recova's hero card: a label, one large figure and a line beneath. */
function HeroCard({
  label,
  value,
  valueClassName,
  sub,
}: {
  label: string;
  value: string;
  valueClassName?: string | null;
  sub: string;
}) {
  return (
    <Panel size="sm" title={label}>
      <p className={`fh-mono fh-display fh-medium cap-num ${valueClassName ?? "fh-text"}`}>
        {value}
      </p>
      <p className="fh-console-sub fh-small fh-faint">{sub}</p>
    </Panel>
  );
}

/** Whether any currency's total is above zero. A tone needs only the sign, so
 *  no figure is ever added across currencies. */
const anyAboveZero = (rows: readonly { cents: number }[]) => rows.some((r) => r.cents > 0);

export function ConsoleHeroRow({ hero }: { hero: ConsoleHero }) {
  return (
    <div className="fh-console-tiles">
      <HeroCard
        label="Protected this month"
        value={formatCurrencyTotalsShort(hero.protectedThisMonth)}
        valueClassName={anyAboveZero(hero.protectedThisMonth) ? "fh-success" : null}
        sub={protectedSubtext(hero.recoveredAllTimeCount)}
      />
      {/* The real total of what is in recovery now, per currency. Recova shipped
          a literal $0 here (const atRiskCents = 0) while its subtext carried
          the signal: a figure that was never true (RULES.md 1.2, copy where
          Recova lied). */}
      <HeroCard
        label="At risk right now"
        value={formatCurrencyTotalsShort(hero.atRisk)}
        sub={atRiskSubtext(hero.activeSequenceCount, hero.openDisputeCount)}
      />
      <HeroCard
        label="Platform health"
        value={hero.recoveryRatePct === null ? "-" : `${hero.recoveryRatePct}%`}
        valueClassName={recoveryRateClassNameOrNull(hero.recoveryRatePct)}
        sub={recoveryRateBand(hero.recoveryRatePct)}
      />
    </div>
  );
}

export function ConsoleTileRow({ tiles, nowMs }: { tiles: ConsoleTiles; nowMs: number }) {
  const recovered = anyAboveZero(tiles.recoveredThisMonth);
  const highRisk = anyAboveZero(tiles.highRiskMrr);
  return (
    <ul className="fh-console-products" aria-label="Products">
      <li className="fh-fill">
        {tiles.stripeConnected ? (
          <StatTile
            label="Recovery"
            figure={formatCurrencyTotalsShort(tiles.recoveredThisMonth)}
            unit="this month"
            tone={recovered ? "ok" : undefined}
            detail={
              tiles.recoveryRatePct === null ? "No failures yet" : `${tiles.recoveryRatePct}% rate`
            }
            href="/recovery/dashboard"
            renderLink={routerRenderLink}
          />
        ) : (
          <StatTile
            label="Recovery"
            figure="Connect Stripe"
            href="/connect"
            renderLink={routerRenderLink}
          />
        )}
      </li>

      {/* Always active. Recova gated this tile on account_products, which
          nothing in Foxhound writes, and dispute intake is webhook-driven with
          no switch to turn on, so the "Enable in Settings"
          state could never be true. */}
      <li className="fh-fill">
        <StatTile
          label="Disputes"
          figure={String(tiles.openDisputeCount)}
          unit="open"
          // Recova keeps the open count neutral and makes only the due line red.
          // A tile tone would color the figure too, so the line carries the
          // color and the tile takes none.
          detail={
            tiles.disputesDueSoonCount > 0 ? (
              <span className="fh-medium fh-error">{tiles.disputesDueSoonCount} due in 48h</span>
            ) : undefined
          }
          href="/disputes/dashboard"
          renderLink={routerRenderLink}
        />
      </li>

      <li className="fh-fill">
        <StatTile
          label="Intelligence"
          figure={formatCurrencyTotalsShort(tiles.highRiskMrr)}
          unit="MRR at risk"
          // Recova's figure for MRR at risk is amber while any is at risk and
          // green when none is: Capsomer's warn tone, then ok.
          tone={highRisk ? "warn" : "ok"}
          detail={
            tiles.highRiskCustomerCount > 0
              ? `${tiles.highRiskCustomerCount} high-risk`
              : "All healthy"
          }
          href="/intelligence/dashboard"
          renderLink={routerRenderLink}
        />
      </li>

      {/* Always available, as in Recova. /audit/dashboard is the signed-in list
          of the account's runs, at Recova's path. */}
      <li className="fh-fill">
        {tiles.lastAuditAt ? (
          <StatTile
            label="Audit"
            figure={formatCurrencyTotalsShort(tiles.auditLeaking)}
            unit="leaking"
            tone={anyAboveZero(tiles.auditLeaking) ? "crit" : "ok"}
            detail={lastRunPhrase(tiles.lastAuditAt, nowMs)}
            href="/audit/dashboard"
            renderLink={routerRenderLink}
          />
        ) : (
          <StatTile
            label="Audit"
            figure="Run free audit"
            href="/audit/connect"
            renderLink={routerRenderLink}
          />
        )}
      </li>
    </ul>
  );
}

/** Recova's urgent rows have a red dot. Capsomer marks a critical row with its
 *  red edge; the other two tones are told apart by their words. */
const ROW_TONE: Record<AttentionRow["tone"], "crit" | undefined> = {
  urgent: "crit",
  warning: undefined,
  subtle: undefined,
};

export function ConsoleAttentionFeed({ rows }: { rows: AttentionRow[] }) {
  // Recova's list has no heading of its own; the list's name gives a screen
  // reader one without adding a visible heading Recova never had.
  if (rows.length === 0) {
    return <p className="fh-small fh-faint">All clear. The platform is running.</p>;
  }
  return (
    <ul className="cap-rows" role="list" aria-label="Needs attention">
      {rows.map((row) => (
        <li key={row.key} className="cap-row" data-tone={ROW_TONE[row.tone]}>
          <div className="cap-row-title">
            <span className="fh-text">{row.subject}</span>{" "}
            <span className="fh-soft">{row.detail}</span>
            {row.emphasis ? (
              <>
                {" "}
                <span className={row.tone === "urgent" ? "fh-medium fh-error" : "fh-faint"}>
                  {row.emphasis}
                </span>
              </>
            ) : null}
            {row.mrrCents && row.mrrCurrency ? (
              <span className="fh-faint">
                {" "}
                ({formatMoneyShort(row.mrrCents, row.mrrCurrency)}/mo)
              </span>
            ) : null}
          </div>
          <span className="cap-row-meta">
            <Pill variant="secondary">{row.product}</Pill>
          </span>
          {row.href ? (
            <div className="cap-row-actions">
              <ButtonLink to={row.href} label={row.ariaLabel} variant="quiet" size="xs" iconOnly>
                <Icon d={iconArrowRight} className="fh-icon-14 fh-icon-fine" />
              </ButtonLink>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
