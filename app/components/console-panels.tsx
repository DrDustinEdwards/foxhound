import { ArrowRight, RefreshCw, ScanSearch, Shield, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router";

import { INTELLIGENCE_PRICE_CENTS } from "~/lib/constants";
import { lastRunPhrase } from "~/lib/dashboard/console";
import { recoveryRateBand, recoveryRateClassNameOrNull } from "~/lib/dashboard/recovery-rate";
import { formatMoney, formatMoneyShort } from "~/lib/money-format";
import type { AttentionRow, AttentionTone, ConsoleHero, ConsoleTiles } from "~/lib/dashboard/console.server";

// The console cluster's presentation: hero row, product tiles, needs-attention
// feed. Pure components; every number arrives already computed from
// app/lib/dashboard/console.server.ts.
//
// Type-only imports from the .server module are safe (erased at build). No value
// import from it appears here, which is what would fail the client build.

/** Dot color per attention tone. The brand accent is not used: a dot is decoration, and the
 *  one-accent-per-card budget belongs to something a merchant can act on. */
const TONE_DOT_CLASS: Record<AttentionTone, string> = {
  urgent: "bg-red",
  warning: "bg-warning-text",
  subtle: "bg-text-subtle",
};

export function ConsoleHeroRow({ hero }: { hero: ConsoleHero }) {
  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Protected this month
        </p>
        <p
          className={`m-0 mt-2 font-mono text-display font-medium tabular-nums ${
            hero.protectedThisMonthCents > 0 ? "text-success-text" : "text-text"
          }`}
        >
          {formatMoneyShort(hero.protectedThisMonthCents, hero.protectedCurrency)}
        </p>
        <p className="m-0 mt-1 text-label text-text-tertiary">
          {hero.recoveredAllTimeCount === 0
            ? "No recoveries yet"
            : `${hero.recoveredAllTimeCount} ${hero.recoveredAllTimeCount === 1 ? "payment" : "payments"} recovered all time`}
        </p>
      </div>

      {/* The real sum of what is currently in recovery. Legacy shipped a literal
          $0 here with the actual signal demoted to the subtext. */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          At risk right now
        </p>
        <p className="m-0 mt-2 font-mono text-display font-medium tabular-nums text-text">
          {formatMoneyShort(hero.atRiskCents, hero.atRiskCurrency)}
        </p>
        <p className="m-0 mt-1 text-label text-text-tertiary">
          {atRiskParts(hero.activeSequenceCount, hero.openDisputeCount)}
        </p>
      </div>

      <div className="rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Platform health
        </p>
        <p
          className={`m-0 mt-2 font-mono text-display font-medium tabular-nums ${recoveryRateClassNameOrNull(hero.recoveryRatePct)}`}
        >
          {hero.recoveryRatePct === null ? "-" : `${hero.recoveryRatePct}%`}
        </p>
        <p className="m-0 mt-1 text-label text-text-tertiary">
          {recoveryRateBand(hero.recoveryRatePct)}
        </p>
      </div>
    </section>
  );
}

function atRiskParts(activeSequenceCount: number, openDisputeCount: number): string {
  const parts: string[] = [];
  if (activeSequenceCount > 0) {
    parts.push(`${activeSequenceCount} active ${activeSequenceCount === 1 ? "sequence" : "sequences"}`);
  }
  if (openDisputeCount > 0) {
    parts.push(`${openDisputeCount} open ${openDisputeCount === 1 ? "dispute" : "disputes"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "All clear";
}

function Tile({
  icon: Icon,
  name,
  href,
  dimmed,
  children,
}: {
  icon: LucideIcon;
  name: string;
  href: string;
  dimmed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={href}
      className={`flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 no-underline transition-opacity hover:opacity-80 ${
        dimmed ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-text-tertiary" strokeWidth={1.5} aria-hidden="true" />
          <span className="text-label font-medium text-text">{name}</span>
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-text-tertiary" strokeWidth={1.5} aria-hidden="true" />
      </div>
      {children}
    </Link>
  );
}

/**
 * A tile's headline number with its unit caption.
 *
 * flex-wrap is load-bearing, not decoration. The tile grid is two columns at
 * 375px, which leaves about 131px of content per tile after the outer padding,
 * the column gap, and the tile's own p-4. A value like "$5,381" beside a caption
 * like "MRR at risk" does not fit on one line in that space, so without wrapping
 * the caption would push past the tile edge. Wrapped, it drops under the number.
 */
function TileValue({ value, caption, className }: { value: string; caption: string; className?: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className={`font-mono text-title font-medium tabular-nums ${className ?? "text-text"}`}>{value}</span>
      <span className="font-mono text-micro text-text-tertiary">{caption}</span>
    </span>
  );
}

/** The call-to-action an inactive tile shows instead of a number. */
function TileCta({ label }: { label: string }) {
  return <span className="text-micro font-medium text-brand-text">{label}</span>;
}

export function ConsoleTileRow({ tiles, nowMs }: { tiles: ConsoleTiles; nowMs: number }) {
  return (
    <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Tile
        icon={RefreshCw}
        name="Recovery"
        href={tiles.stripeConnected ? "/recovery/dashboard" : "/connect"}
        dimmed={!tiles.stripeConnected}
      >
        {tiles.stripeConnected ? (
          <>
            <TileValue
              value={formatMoneyShort(tiles.recoveredThisMonthCents, tiles.recoveredCurrency)}
              caption="this month"
              className={tiles.recoveredThisMonthCents > 0 ? "text-success-text" : undefined}
            />
            <span className="text-micro text-text-subtle">
              {tiles.recoveryRatePct === null ? "No failures yet" : `${tiles.recoveryRatePct}% rate`}
            </span>
          </>
        ) : (
          <TileCta label="Connect Stripe" />
        )}
      </Tile>

      {/* No inactive state: dispute intake is webhook-driven, so there is nothing
          for a merchant to switch on. */}
      <Tile icon={Shield} name="Disputes" href="/disputes/dashboard">
        <TileValue value={String(tiles.openDisputeCount)} caption="open" />
        {tiles.disputesDueSoonCount > 0 ? (
          <span className="text-micro font-medium text-error-text">
            {tiles.disputesDueSoonCount} due in 48h
          </span>
        ) : (
          <span className="text-micro text-text-subtle">Nothing due soon</span>
        )}
      </Tile>

      <Tile
        icon={TrendingUp}
        name="Intelligence"
        href={tiles.intelligenceEntitled ? "/intelligence/dashboard" : "/billing"}
        dimmed={!tiles.intelligenceEntitled}
      >
        {tiles.intelligenceEntitled ? (
          <>
            <TileValue
              value={formatMoneyShort(tiles.highRiskMrrCents, tiles.recoveredCurrency)}
              caption="MRR at risk"
              className={tiles.highRiskMrrCents > 0 ? "text-caution" : "text-success-text"}
            />
            <span className="text-micro text-text-subtle">
              {tiles.highRiskCustomerCount > 0
                ? `${tiles.highRiskCustomerCount} at risk`
                : "All healthy"}
            </span>
          </>
        ) : (
          <span className="text-micro text-text-subtle">
            <span className="font-mono">{formatMoneyShort(INTELLIGENCE_PRICE_CENTS, "usd")}/mo</span>
            {" · "}
            <span className="font-medium text-brand-text">Subscribe</span>
          </span>
        )}
      </Tile>

      <Tile icon={ScanSearch} name="Audit" href="/audit">
        {tiles.lastAuditAt ? (
          <>
            <TileValue
              value={formatMoneyShort(tiles.auditLeakingCents, tiles.recoveredCurrency)}
              caption="leaking"
              className={tiles.auditLeakingCents > 0 ? "text-error-text" : "text-success-text"}
            />
            <span className="text-micro text-text-subtle">{lastRunPhrase(tiles.lastAuditAt, nowMs)}</span>
          </>
        ) : (
          <TileCta label="Run free audit" />
        )}
      </Tile>
    </section>
  );
}

export function ConsoleAttentionFeed({
  rows,
  currency,
}: {
  rows: AttentionRow[];
  currency: string;
}) {
  return (
    <section className="mt-8">
      <h2 className="m-0 font-mono text-micro uppercase tracking-wide text-text-tertiary">
        Needs attention
      </h2>
      {rows.length === 0 ? (
        <p className="m-0 mt-3 text-label text-text-tertiary">
          All clear. The platform is running.
        </p>
      ) : (
        <ul className="m-0 mt-2 list-none p-0">
          {rows.map((row, i) => (
            <li
              key={row.key}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-3 ${i > 0 ? "border-t border-border-sub" : ""}`}
            >
              <span
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT_CLASS[row.tone]}`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 text-label">
                <span className="text-text">{row.subject}</span>{" "}
                <span className="text-text-secondary">{row.detail}</span>
                {row.emphasis ? (
                  <>
                    {" "}
                    <span className={row.tone === "urgent" ? "font-medium text-error-text" : "text-text-tertiary"}>
                      {row.emphasis}
                    </span>
                  </>
                ) : null}
                {row.mrrCents ? (
                  <span className="text-text-subtle"> ({formatMoney(row.mrrCents, currency)}/mo)</span>
                ) : null}
              </span>
              <span className="shrink-0 rounded bg-surface2 px-1.5 py-0.5 font-mono text-micro text-text-tertiary">
                {row.product}
              </span>
              {row.href ? (
                <Link
                  to={row.href}
                  aria-label={row.ariaLabel}
                  className="shrink-0 text-text-tertiary no-underline hover:text-text"
                >
                  <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
