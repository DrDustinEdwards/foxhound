import { formatCount } from "@drdustinedwards/site-helpers/text";
import { useId } from "react";
import { ChartPanel } from "capsomer/react/chart-frame";
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

import "~/components/charts.css";
import { accountScope } from "~/lib/auth/context";
import { sanitizeEmailPreviewHtml } from "~/lib/recovery/email-preview.server";
import { listExecutedRecoverySteps } from "~/lib/recovery/step-queries.server";
import {
  SEQUENCE_CATEGORY_DESCRIPTIONS,
  SEQUENCE_CATEGORY_NAMES,
  SEQUENCE_CATEGORY_ORDER,
  sequenceRateClassName,
} from "~/lib/recovery/sequence-categories";
import { drawStepPerformance, STEP_PERFORMANCE_NOTE } from "~/lib/recovery/sequence-chart";
import {
  buildCategorySections,
  summarizeStepPerformance,
  type CategorySection,
  type StepCard,
  type StepPerformanceSummary,
} from "~/lib/recovery/sequence-performance";

import type { Route } from "./+types/sequences";
import { noindexMeta } from "~/lib/seo/meta";
import { markup } from "capsomer/behavior/trusted-html";

// /recovery/sequence: the sections are Capsomer's parts, the chart is Enarratio's, and the numbers and categories are Foxhound's engine (RECOVERY_SCHEDULES, six categories, silent retry first).

export const meta = noindexMeta("Sequences - Foxhound");

export async function loader({ context }: Route.LoaderArgs) {
  const { db, accountId } = accountScope(context);

  const rawSteps = await listExecutedRecoverySteps(db, accountId);
  // Sanitize once, here, server-side: the pure aggregation module never touches raw AI HTML (see email-preview.server.ts).
  const steps = rawSteps.map((s) => ({
    ...s,
    aiBodyHtml: s.aiBodyHtml ? sanitizeEmailPreviewHtml(s.aiBodyHtml) : null,
  }));

  const performance = summarizeStepPerformance(steps);
  const sections = buildCategorySections(SEQUENCE_CATEGORY_ORDER, steps);

  return { performance, sections };
}

// The chart draws at the page's content width on the server, then at its
// measured width in the browser (ChartFrame).
const CHART_WIDTH = 1120;

/** A label, a figure, and an optional line under it. */
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
      <p className={`fh-mono fh-title fh-semibold cap-num ${valueClassName ?? "fh-text"}`}>
        {value}
      </p>
      {sub ? <p className="fh-tiny fh-quiet">{sub}</p> : null}
    </Panel>
  );
}

function StatRow({ performance }: { performance: StepPerformanceSummary }) {
  return (
    <div className="fh-sequence-tiles">
      <StatCard label="Emails sent" value={formatCount(performance.totalSent)} />
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
        sub={
          performance.bestStep ? `${performance.bestStep.clickRatePct}% click rate` : "min 3 sends"
        }
      />
    </div>
  );
}

function StepPerformanceChart({ chart }: { chart: StepPerformanceSummary["chart"] }) {
  if (chart.length === 0) {
    return (
      <ChartPanel title="Step performance" empty={{ reason: "No step performance to show yet." }} />
    );
  }
  return (
    <ChartPanel
      title="Step performance"
      src={STEP_PERFORMANCE_NOTE}
      gridlines="none"
      width={CHART_WIDTH}
      draw={(width, fit) => drawStepPerformance(chart, width, fit)}
    />
  );
}

function Figure({
  value,
  label,
  className,
}: {
  value: string | number;
  label: string;
  className?: string;
}) {
  return (
    <div className="fh-right">
      <p className={`fh-mono fh-body fh-semibold cap-num ${className ?? "fh-text"}`}>{value}</p>
      <p className="fh-tiny fh-quiet fh-caps">{label}</p>
    </div>
  );
}

function StepFigures({ card }: { card: StepCard }) {
  if (card.kind === "retry") {
    if (card.attempted === 0 || card.successRatePct === null) {
      return <span className="fh-tiny fh-quiet">No data yet</span>;
    }
    return (
      <div className="fh-right">
        <p
          className={`fh-mono fh-body fh-semibold cap-num ${sequenceRateClassName(card.successRatePct, "click")}`}
        >
          {card.successRatePct}%
        </p>
        <p className="fh-tiny fh-quiet">
          {card.recovered} of {card.attempted} recovered
        </p>
      </div>
    );
  }
  if (card.sent === 0 || card.openRatePct === null || card.clickRatePct === null) {
    return <span className="fh-tiny fh-quiet">No data yet</span>;
  }
  return (
    <div className="fh-sequence-steps">
      <Figure value={card.sent} label="sent" />
      <Figure
        value={`${card.openRatePct}%`}
        label="opened"
        className={sequenceRateClassName(card.openRatePct, "open")}
      />
      <Figure
        value={`${card.clickRatePct}%`}
        label="clicked"
        className={sequenceRateClassName(card.clickRatePct, "click")}
      />
    </div>
  );
}

function StepCardView({ card }: { card: StepCard }) {
  const preview =
    card.kind === "email" && card.sent > 0 && card.latestBodyHtml ? card.latestBodyHtml : null;
  const line =
    card.kind === "retry" ? (
      "Automatic retry. No email sent."
    ) : card.sent > 0 && card.latestSubject ? (
      <>Latest subject: {card.latestSubject}</>
    ) : null;
  // The figures sit in the body, on the panel's surface, not in its raised header: the rate colors and the subtle text reach 4.5:1 on the surface in both themes and fall short on the dark raised tone.
  return (
    <Panel
      level={3}
      title={
        <span className="fh-sequence-meta">
          {card.label}
          {card.timingLabel ? <Pill variant="secondary">{card.timingLabel}</Pill> : null}
        </span>
      }
    >
      <div className="fh-sequence-step-top">
        <p className="cap-grow fh-truncate fh-tiny fh-quiet">{line}</p>
        <div className="cap-keep">
          <StepFigures card={card} />
        </div>
      </div>
      {preview !== null ? (
        <Disclosure summary="Preview latest email">
          {/* latestBodyHtml is sanitized server-side in the loader before it
              ever reaches this component (email-preview.server.ts). */}
          <div
            className="fh-sequence-body fh-small fh-relaxed fh-quiet"
            dangerouslySetInnerHTML={markup(preview)}
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
      <h2 id={headingId} className="fh-mb-2-5">
        <Pill variant="outline">{SEQUENCE_CATEGORY_NAMES[section.category]}</Pill>
      </h2>
      <p className="fh-mb-4 fh-small fh-quiet">
        {SEQUENCE_CATEGORY_DESCRIPTIONS[section.category]}
      </p>
      <div className="cap-stack" data-gap="4">
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
    // max-w-[1280px] mx-auto px-4 md:px-8 py-10.
    <div className="fh-sequence cap-admin-page" data-width="page">
      <div className="fh-mb-6">
        <PageHead title="Recovery sequence" />
      </div>

      {performance.totalSent === 0 ? (
        <Empty kind="nothing-yet" title="No emails sent yet" />
      ) : (
        <StatRow performance={performance} />
      )}

      <div className="fh-mt-6">
        <StepPerformanceChart chart={performance.chart} />
      </div>

      <div className="cap-stack fh-mt-7-5" data-gap="7">
        {sections.map((section) => (
          <CategorySectionView key={section.category} section={section} />
        ))}
      </div>
    </div>
  );
}
