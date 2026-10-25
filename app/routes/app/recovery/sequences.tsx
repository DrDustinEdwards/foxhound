import { useId } from "react";
import { barChart } from "enarratio/lite/bar";
import { Disclosure } from "capsomer/react/disclosure";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import "capsomer/disclosure.css";
import "capsomer/empty.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "./dashboard.css";

import { EnarratioFigure } from "~/components/enarratio-figure";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { sanitizeEmailPreviewHtml } from "~/lib/recovery/email-preview.server";
import { listExecutedRecoverySteps } from "~/lib/recovery/queries.server";
import {
  SEQUENCE_CATEGORY_DESCRIPTIONS,
  SEQUENCE_CATEGORY_NAMES,
  SEQUENCE_CATEGORY_ORDER,
  sequenceRateClassName,
} from "~/lib/recovery/sequence-categories";
import {
  STEP_PERFORMANCE_NOTE,
  stepPerformanceAlt,
  stepPerformanceRows,
  STEP_PERFORMANCE_SERIES,
} from "~/lib/recovery/sequence-chart";
import {
  buildCategorySections,
  summarizeStepPerformance,
  type CategorySection,
  type StepCard,
  type StepPerformanceSummary,
} from "~/lib/recovery/sequence-performance";

import type { Route } from "./+types/sequences";

// /recovery/sequence (row S9, job J12). Recova is the spec: its page,
// app/(app)/recovery/sequence/page.tsx at blob 953c3f57, with
// components/SequenceView.tsx 5507b89f, StepPerformanceChart.tsx edf8f83c and
// lib/sequence-utils.ts 061aba7a, each read whole. Every section, label and
// their order are Recova's; the parts are Capsomer 0.9.0's (Q10), the chart is
// Enarratio's (Q1), amber throughout, and the numbers and categories are
// Foxhound's engine (RECOVERY_SCHEDULES, six categories, silent retry first,
// ruling 80).

export function meta() {
  return [{ title: "Sequences - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const accountId = auth.membership.accountId;

  const rawSteps = await listExecutedRecoverySteps(db, accountId);
  // Sanitize once, here, server-side - the pure aggregation module never
  // touches raw AI HTML (see email-preview.server.ts).
  const steps = rawSteps.map((s) => ({
    ...s,
    aiBodyHtml: s.aiBodyHtml ? sanitizeEmailPreviewHtml(s.aiBodyHtml) : null,
  }));

  const performance = summarizeStepPerformance(steps);
  const sections = buildCategorySections(SEQUENCE_CATEGORY_ORDER, steps);

  return { performance, sections };
}

// The chart draws at the page's content width on the server, then at its
// measured width in the browser (EnarratioFigure).
const CHART_WIDTH = 1120;
// Recova's plot is 220px high (StepPerformanceChart.tsx, h-[220px]).
const CHART_HEIGHT = 220;
// About the width of the longest step name ("Revocation email") at the axis's text size.
const X_LABEL_WIDTH = 110;

/** Recova's StatCard: a label, a figure, and an optional line under it. */
function StatCard({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClassName?: string;
}) {
  return (
    <Panel size="sm" title={label}>
      <p className={`m-0 font-mono text-title font-semibold tabular-nums ${valueClassName ?? "text-text"}`}>{value}</p>
      {sub ? <p className="m-0 text-micro text-text-subtle">{sub}</p> : null}
    </Panel>
  );
}

function StatRow({ performance }: { performance: StepPerformanceSummary }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard label="Emails sent" value={performance.totalSent.toLocaleString("en-US")} />
      <StatCard
        label="Avg open rate"
        value={`${performance.avgOpenRatePct}%`}
        valueClassName={sequenceRateClassName(performance.avgOpenRatePct, "open")}
      />
      <StatCard
        label="Avg click rate"
        value={`${performance.avgClickRatePct}%`}
        valueClassName={sequenceRateClassName(performance.avgClickRatePct, "click")}
      />
      <StatCard
        label="Best step"
        value={performance.bestStep ? performance.bestStep.label : "-"}
        sub={performance.bestStep ? `${performance.bestStep.clickRatePct}% click rate` : "min 3 sends"}
      />
    </div>
  );
}

function StepPerformanceChart({ chart }: { chart: StepPerformanceSummary["chart"] }) {
  if (chart.length === 0) {
    return (
      <Panel title="Step performance">
        <p className="m-0 text-label text-text-subtle">No step performance to show yet.</p>
      </Panel>
    );
  }
  return (
    <Panel
      title="Step performance"
      description={STEP_PERFORMANCE_NOTE}
    >
      <EnarratioFigure
        className="fh-recovery-chart"
        initialWidth={CHART_WIDTH}
        draw={(width) =>
          barChart({
            data: stepPerformanceRows(chart),
            x: "Step",
            xDomain: chart.map((c) => c.label),
            y: "rate",
            series: "series",
            layout: "grouped",
            // Recova's funnel order, Open then Click then Recovery, in its
            // colors, except that Recovery rate takes Foxhound's amber.
            seriesDomain: STEP_PERFORMANCE_SERIES,
            colors: { "Open rate": "var(--green)", "Click rate": "var(--blue)", "Recovery rate": "var(--brand-ui)" },
            xLabel: null,
            yLabel: "Rate (%)",
            formatValue: (v) => `${v}%`,
            // Recharts, which drew Recova's chart, skips x labels that would
            // overlap; this prints every nth label once the steps no longer fit.
            maxXTicks: Math.max(2, Math.floor(width / X_LABEL_WIDTH)),
            alt: stepPerformanceAlt(chart),
            width,
            height: CHART_HEIGHT,
          })
        }
      />
    </Panel>
  );
}

function Figure({ value, label, className }: { value: string | number; label: string; className?: string }) {
  return (
    <div className="text-right">
      <p className={`m-0 font-mono text-body font-semibold tabular-nums ${className ?? "text-text"}`}>{value}</p>
      <p className="m-0 text-micro uppercase tracking-wide text-text-tertiary">{label}</p>
    </div>
  );
}

function StepFigures({ card }: { card: StepCard }) {
  if (card.kind === "retry") {
    if (card.attempted === 0 || card.successRatePct === null) {
      return <span className="text-micro text-text-subtle">No data yet</span>;
    }
    return (
      <div className="text-right">
        <p className={`m-0 font-mono text-body font-semibold tabular-nums ${sequenceRateClassName(card.successRatePct, "click")}`}>
          {card.successRatePct}%
        </p>
        <p className="m-0 text-micro text-text-subtle">
          {card.recovered} of {card.attempted} recovered
        </p>
      </div>
    );
  }
  if (card.sent === 0 || card.openRatePct === null || card.clickRatePct === null) {
    return <span className="text-micro text-text-subtle">No data yet</span>;
  }
  return (
    <div className="flex gap-5">
      <Figure value={card.sent} label="sent" />
      <Figure value={`${card.openRatePct}%`} label="opened" className={sequenceRateClassName(card.openRatePct, "open")} />
      <Figure value={`${card.clickRatePct}%`} label="clicked" className={sequenceRateClassName(card.clickRatePct, "click")} />
    </div>
  );
}

function StepCardView({ card }: { card: StepCard }) {
  const preview = card.kind === "email" && card.sent > 0 && card.latestBodyHtml ? card.latestBodyHtml : null;
  const line =
    card.kind === "retry" ? (
      "Automatic retry. No email sent."
    ) : card.sent > 0 && card.latestSubject ? (
      <>Latest subject: {card.latestSubject}</>
    ) : null;
  // The figures sit in the body, on the panel's surface, not in its raised
  // header: the rate colors and the subtle text reach 4.5:1 on the surface in
  // both themes and fall short on the dark raised tone.
  return (
    <Panel
      level={3}
      title={
        <span className="inline-flex flex-wrap items-center gap-2.5">
          {card.label}
          {card.timingLabel ? <Pill variant="secondary">{card.timingLabel}</Pill> : null}
        </span>
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="m-0 min-w-0 flex-1 truncate text-micro text-text-subtle">{line}</p>
        <div className="shrink-0">
          <StepFigures card={card} />
        </div>
      </div>
      {preview !== null ? (
        <Disclosure summary="Preview latest email">
          {/* latestBodyHtml is sanitized server-side in the loader before it
              ever reaches this component (email-preview.server.ts). */}
          <div
            className="overflow-x-auto text-label leading-relaxed text-text-subtle"
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        </Disclosure>
      ) : null}
    </Panel>
  );
}

function CategorySectionView({ section }: { section: CategorySection }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="m-0 mb-1.5">
        <Pill variant="outline">{SEQUENCE_CATEGORY_NAMES[section.category]}</Pill>
      </h2>
      <p className="m-0 mb-3 text-label text-text-subtle">{SEQUENCE_CATEGORY_DESCRIPTIONS[section.category]}</p>
      <div className="flex flex-col gap-3">
        {section.stepCards.map((card) => (
          <StepCardView key={card.stepType} card={card} />
        ))}
      </div>
    </section>
  );
}

export default function RecoverySequences({ loaderData }: Route.ComponentProps) {
  const { performance, sections } = loaderData;

  return (
    // Recova's main: max-w-[1280px] mx-auto px-4 md:px-8 py-10.
    <div className="mx-auto max-w-[1280px] px-4 py-10 md:px-8">
      <div className="mb-6">
        <PageHead title="Recovery sequence" lead="Live performance data from your recovery emails" />
      </div>

      {performance.totalSent === 0 ? (
        <Empty kind="nothing-yet" title="No emails sent yet">
          Recovery sequences start automatically when a payment fails.
        </Empty>
      ) : (
        <StatRow performance={performance} />
      )}

      <div className="mt-6">
        <StepPerformanceChart chart={performance.chart} />
      </div>

      <div className="mt-10 flex flex-col gap-8">
        {sections.map((section) => (
          <CategorySectionView key={section.category} section={section} />
        ))}
      </div>
    </div>
  );
}
