import { ArrowRight } from "lucide-react";
import { Link } from "capsomer/react/link";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import { StatTile, type StatTileLinkProps } from "capsomer/react/stat-tile";
import "capsomer/button.css";
import "capsomer/panel.css";
import "capsomer/row-list.css";
import "capsomer/stat-tile.css";
import "capsomer/status.css";

import { atRiskSubtext, formatCurrencyTotalsShort, lastRunPhrase, protectedSubtext } from "~/lib/dashboard/console";
import { recoveryRateBand, recoveryRateClassNameOrNull } from "~/lib/dashboard/recovery-rate";
import { formatMoneyShort } from "~/lib/money-format";
import type { AttentionRow, ConsoleHero, ConsoleTiles } from "~/lib/dashboard/console.server";

// The console's three parts in Recova's order (app/(app)/console/page.tsx at
// blob 3b8a736e, with lib/console-data.tsx at 234791c4): the hero row of three
// platform figures, the four product tiles, then the needs-attention rows.
// Built from Capsomer 0.9.0's parts (Q10): the hero cards are Panels, the
// product tiles are StatTiles, the attention rows are row-list rows with a
// Pill for the product. No Foxhound CSS sits over a Capsomer component; what
// Recova's look needs beyond Capsomer's defaults (the tile icons and arrows,
// the dimmed inactive tile, the row's colored dot) waits for Capsomer's
// per-site layer (capsomer job_ec5ec0754626) and is listed in the J64 pull
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
      <p className={`m-0 font-mono text-display font-medium tabular-nums ${valueClassName ?? "text-text"}`}>{value}</p>
      <p className="m-0 mt-1 text-label text-text-subtle">{sub}</p>
    </Panel>
  );
}

/** Whether any currency's total is above zero. A tone needs only the sign, so
 *  no figure is ever added across currencies (RULES.md 3.20). */
const anyAboveZero = (rows: readonly { cents: number }[]) => rows.some((r) => r.cents > 0);

export function ConsoleHeroRow({ hero }: { hero: ConsoleHero }) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <HeroCard
        label="Protected this month"
        value={formatCurrencyTotalsShort(hero.protectedThisMonth)}
        valueClassName={anyAboveZero(hero.protectedThisMonth) ? "text-success-text" : null}
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

/** A tile's link through the router, so it navigates without a reload. */
const routerLink = ({ href, children, ...rest }: StatTileLinkProps) => (
  <Link to={href} {...rest}>
    {children}
  </Link>
);

export function ConsoleTileRow({ tiles, nowMs }: { tiles: ConsoleTiles; nowMs: number }) {
  const recovered = anyAboveZero(tiles.recoveredThisMonth);
  const highRisk = anyAboveZero(tiles.highRiskMrr);
  return (
    <ul className="m-0 mb-8 grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4" aria-label="Products">
      <li className="grid">
        {tiles.stripeConnected ? (
          <StatTile
            label="Recovery"
            figure={formatCurrencyTotalsShort(tiles.recoveredThisMonth)}
            unit="this month"
            tone={recovered ? "ok" : undefined}
            detail={tiles.recoveryRatePct === null ? "No failures yet" : `${tiles.recoveryRatePct}% rate`}
            href="/recovery/dashboard"
            renderLink={routerLink}
          />
        ) : (
          <StatTile label="Recovery" figure="Connect Stripe" href="/connect" renderLink={routerLink} />
        )}
      </li>

      {/* Always active. Recova gated this tile on account_products, which
          nothing in Foxhound writes, and dispute intake is webhook-driven with
          no switch to turn on (RULES.md 3.18), so the "Enable in Settings"
          state could never be true. */}
      <li className="grid">
        <StatTile
          label="Disputes"
          figure={String(tiles.openDisputeCount)}
          unit="open"
          // Recova keeps the open count neutral and makes only the due line red.
          // A tile tone would color the figure too, so the line carries the
          // color and the tile takes none.
          detail={
            tiles.disputesDueSoonCount > 0 ? (
              <span className="font-medium text-error-text">{tiles.disputesDueSoonCount} due in 48h</span>
            ) : undefined
          }
          href="/disputes/dashboard"
          renderLink={routerLink}
        />
      </li>

      <li className="grid">
        <StatTile
          label="Intelligence"
          figure={formatCurrencyTotalsShort(tiles.highRiskMrr)}
          unit="MRR at risk"
          // Recova's figure for MRR at risk is amber while any is at risk and
          // green when none is: Capsomer's warn tone, then ok.
          tone={highRisk ? "warn" : "ok"}
          detail={tiles.highRiskCustomerCount > 0 ? `${tiles.highRiskCustomerCount} high-risk` : "All healthy"}
          href="/intelligence/dashboard"
          renderLink={routerLink}
        />
      </li>

      {/* Always available, as in Recova. /audit/dashboard is the signed-in list
          of the account's runs, at Recova's path. */}
      <li className="grid">
        {tiles.lastAuditAt ? (
          <StatTile
            label="Audit"
            figure={formatCurrencyTotalsShort(tiles.auditLeaking)}
            unit="leaking"
            tone={anyAboveZero(tiles.auditLeaking) ? "crit" : "ok"}
            detail={lastRunPhrase(tiles.lastAuditAt, nowMs)}
            href="/audit/dashboard"
            renderLink={routerLink}
          />
        ) : (
          <StatTile label="Audit" figure="Run free audit" href="/audit/connect" renderLink={routerLink} />
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
    return <p className="m-0 text-label text-text-subtle">All clear. The platform is running.</p>;
  }
  return (
    <ul className="cap-rows" role="list" aria-label="Needs attention">
      {rows.map((row) => (
        <li key={row.key} className="cap-row" data-tone={ROW_TONE[row.tone]}>
          <div className="cap-row-title">
            <span className="text-text">{row.subject}</span>{" "}
            <span className="text-text-secondary">{row.detail}</span>
            {row.emphasis ? (
              <>
                {" "}
                <span className={row.tone === "urgent" ? "font-medium text-error-text" : "text-text-subtle"}>
                  {row.emphasis}
                </span>
              </>
            ) : null}
            {row.mrrCents && row.mrrCurrency ? (
              <span className="text-text-subtle"> ({formatMoneyShort(row.mrrCents, row.mrrCurrency)}/mo)</span>
            ) : null}
          </div>
          <span className="cap-row-meta">
            <Pill variant="secondary">{row.product}</Pill>
          </span>
          {row.href ? (
            <div className="cap-row-actions">
              <Link
                to={row.href}
                aria-label={row.ariaLabel}
                className="cap-btn"
                data-variant="quiet"
                data-size="xs"
                data-icon-only=""
              >
                <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              </Link>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
