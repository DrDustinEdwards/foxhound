import { plural } from "@drdustinedwards/site-helpers/text";
import { AlertCircle, Percent, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Pill, Status, type Tone } from "capsomer/react/status";
import { Link } from "capsomer/react/link";

import { CategoryPill, StepChip } from "~/components/tone-pills";
import type { DeclineCategory } from "~/lib/constants";
import type { RecoveryRateTone } from "~/lib/dashboard/recovery-rate";
import type {
  PreviewPaymentRow,
  RecoveryPreview,
  RoiColumn,
} from "~/lib/marketing/recovery-preview";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { isRetryStep, RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";

// The three previews on /product/recovery, Recova's three feature-block
// UIs: the category sequences (page.tsx's CategorySequencePreview with
// CategoryPill and SequenceTimeline, drawn by SequenceSteps here and on /features and the guide), the dashboard (RecoveryDashboardPreview:
// StatCards' primary row and ROIWidget) and the payments table
// (RecoveryPaymentsPreview: PaymentsTable and PaymentRow's preview row).
//
// Content and layout are Recova's; the parts are Capsomer's. The
// sequences are read from RECOVERY_SCHEDULES and every figure from the demo
// seed (app/lib/marketing/recovery-preview.server.ts), never a merchant's rows.
// Recova draws no chart in any of the three, so neither does this page.

const CATEGORIES = Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[];

/** Recova's step timing words: "4 hr" under a day, "Day N" from a day on. */
export function timingLabel(offsetHours: number): string {
  if (offsetHours < 24) return `${offsetHours} hr`;
  return `Day ${Math.round(offsetHours / 24)}`;
}

export function SequenceSteps({ category }: { category: DeclineCategory }) {
  const steps = RECOVERY_SCHEDULES[category];
  const label = DECLINE_CATEGORY_LABELS[category];
  const count = plural(steps.length, "step");
  return (
    <div className="cap-panel">
      <div className="cap-panel-body">
        <div>
          <div className="mb-3 fh-tiny fh-medium fh-quiet fh-caps-wide">
            {label}: {count}
          </div>
          {/* Recova's row scrolls sideways on a narrow screen; this one wraps instead, since no
              page may need a sideways scrollbar (Dustin, 2026-10-30). */}
          <div className="pb-2">
            <ol
              aria-label={`${label} sequence, ${count}`}
              className="flex flex-wrap items-center gap-x-1 gap-y-2"
            >
              {steps.map((step, i) => {
                const retry = isRetryStep(step.stepType);
                return (
                  <li key={step.stepType} className="flex items-center gap-1">
                    <StepChip retry={retry} timing={timingLabel(step.offsetHours)} />
                    {i < steps.length - 1 ? (
                      <span className="cap-keep h-px w-4 bg-border" aria-hidden="true" />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CategorySequencePreview() {
  return (
    <div className="flex flex-col gap-4 p-5">
      {CATEGORIES.map((category) => (
        <div key={category} data-category={category}>
          <div className="mb-2 flex items-center gap-2">
            <CategoryPill category={category} />
            <span className="fh-mono fh-small fh-quiet">
              {DECLINE_CATEGORY_LABELS[category]} sequence
            </span>
          </div>
          <SequenceSteps category={category} />
        </div>
      ))}
    </div>
  );
}

const RATE_STATUS: Record<RecoveryRateTone, { tone: Tone; className: string }> = {
  green: { tone: "ok", className: "fh-success" },
  caution: { tone: "warn", className: "text-caution" },
  red: { tone: "crit", className: "fh-error" },
};

function Figure({
  icon: Icon,
  label,
  value,
  className,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  className: string;
  sub?: React.ReactNode;
}) {
  // Recova's stat card leads nowhere, so it is a panel with a figure in it,
  // not Capsomer's stat tile, which is always a link or a button.
  return (
    <li className="cap-panel">
      <div className="cap-panel-body">
        <div>
          <Icon className={`mb-2 h-4 w-4 ${className}`} strokeWidth={1.5} aria-hidden />
          <p className="mb-2 fh-tiny fh-medium fh-quiet">{label}</p>
          <p className={`fh-mono fh-display fh-bold tracking-[-0.5px] ${className}`}>{value}</p>
          {sub ? <div className="mt-1 fh-tiny">{sub}</div> : null}
        </div>
      </div>
    </li>
  );
}

function RoiRows({
  heading,
  rows,
}: {
  heading: string;
  rows: [string, string, "plain" | "fee" | "net"][];
}) {
  return (
    <div>
      <h4 className="mb-3 fh-tiny fh-medium uppercase tracking-[0.06em] fh-quiet">{heading}</h4>
      <dl className="cap-stack" data-gap="3">
        {rows.map(([label, value, kind]) => (
          <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className={`fh-small ${kind === "fee" ? "fh-quiet" : "fh-soft"}`}>{label}</dt>
            <dd
              className={`fh-mono fh-body cap-num ${
                kind === "net" ? "fh-bold fh-success" : kind === "fee" ? "fh-quiet" : "fh-text"
              }`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function DashboardPreview({ preview }: { preview: RecoveryPreview }) {
  const { dashboard, roi } = preview;
  const rate = dashboard.rateTone ? RATE_STATUS[dashboard.rateTone] : null;
  const month: RoiColumn = roi.thisMonth;
  const all: RoiColumn = roi.allTime;
  return (
    <div className="p-5">
      <ul className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Recovery figures">
        <Figure
          icon={TrendingUp}
          label="Recovered (30d)"
          value={dashboard.recovered30d}
          className="fh-success"
        />
        <Figure
          icon={AlertCircle}
          label="Currently at risk"
          value={dashboard.atRisk}
          className="fh-error"
        />
        <Figure
          icon={Percent}
          label="Recovery rate"
          value={dashboard.ratePct === null ? "-" : `${dashboard.ratePct}%`}
          className={rate?.className ?? "fh-faint"}
          sub={<Status tone={rate?.tone ?? "nodata"}>{dashboard.rateBand}</Status>}
        />
      </ul>
      <div className="cap-panel">
        <div className="cap-panel-body">
          <div className="grid grid-cols-2">
            <div className="min-w-0 border-r border-border pr-6">
              <RoiRows
                heading="This month"
                rows={[
                  ["Recovered by Foxhound", month.recovered, "plain"],
                  [`Foxhound fee (${roi.feePct}%)`, month.fee, "fee"],
                  ["You kept", month.kept, "net"],
                ]}
              />
            </div>
            <div className="min-w-0 pl-6">
              <RoiRows
                heading="All time"
                rows={[
                  ["Total recovered by Foxhound", all.recovered, "plain"],
                  ["Total fees paid", all.fee, "fee"],
                  ["Net to you", all.kept, "net"],
                ]}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A payment's status as Capsomer's status badge: the tab word, its glyph and tone. */
function StatusPill({ row }: { row: PreviewPaymentRow }) {
  if (row.status === "recovered") return <Pill tone="ok">{row.statusLabel}</Pill>;
  if (row.status === "failed_unrecovered") return <Pill tone="crit">{row.statusLabel}</Pill>;
  if (row.status === "cancelled") return <Pill tone="nodata">{row.statusLabel}</Pill>;
  // Active and Stripe retrying: a sequence is running.
  return (
    <Pill tone="info" running>
      {row.statusLabel}
    </Pill>
  );
}

function FailureCount({ row }: { row: PreviewPaymentRow }) {
  return row.failureCount > 1 ? <Pill variant="secondary">{row.failureCount}x failure</Pill> : null;
}

const HEADING_ID = "recovery-preview-payments";

export function PaymentsPreview({ preview }: { preview: RecoveryPreview }) {
  const { totalCount, activeCount, rows } = preview.payments;
  return (
    <div className="p-5">
      <section className="cap-panel">
        <header className="cap-panel-head">
          <h4 id={HEADING_ID}>Failed payments</h4>
          <span className="cap-panel-src">
            {totalCount} total · {activeCount} active
          </span>
          <span className="cap-panel-more">
            <Link to="/audit">View all</Link>
          </span>
        </header>
        <div className="cap-panel-body" data-flush>
          {/* Recova's phone layout: one card per payment. */}
          <ul className="sm:hidden">
            {rows.map((row) => (
              <li key={row.id} className="border-b border-border px-5 py-4 last:border-b-0">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="cap-grow">
                    <div className="fh-truncate fh-small fh-medium fh-text">{row.customer}</div>
                    {row.email ? (
                      <div className="fh-truncate fh-tiny fh-faint">{row.email}</div>
                    ) : null}
                  </div>
                  <span className="fh-nowrap fh-mono fh-small fh-accent">{row.amount}</span>
                </div>
                <div className="cap-cluster" data-gap="3">
                  <CategoryPill category={row.category} />
                  <StatusPill row={row} />
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
            <div
              className="cap-table-wrap"
              data-reflow=""
              role="region"
              aria-labelledby={HEADING_ID}
              tabIndex={0}
            >
              <table className="cap-table">
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Decline</th>
                    <th scope="col">Steps</th>
                    <th scope="col">Status</th>
                    <th scope="col">Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        <div className="cap-cluster" data-gap="3">
                          <span className="fh-small fh-medium fh-text">{row.customer}</span>
                          <FailureCount row={row} />
                        </div>
                        {row.email ? (
                          <div className="mt-0.5 fh-tiny fh-regular fh-faint">{row.email}</div>
                        ) : null}
                        {row.plan ? (
                          <div className="mt-0.5 fh-tiny fh-regular fh-faint">{row.plan}</div>
                        ) : null}
                      </th>
                      <td data-label="Amount" className="fh-nowrap">
                        <span className="fh-mono fh-small fh-accent">{row.amount}</span>
                      </td>
                      <td data-label="Decline">
                        <CategoryPill category={row.category} />
                        {row.declineCode ? (
                          <div className="mt-1 fh-mono fh-tiny fh-faint">{row.declineCode}</div>
                        ) : null}
                      </td>
                      <td data-label="Steps">
                        <span
                          className={`fh-mono fh-tiny ${row.stepsDone > 0 ? "fh-text" : "fh-faint"}`}
                        >
                          {row.stepsDone}/{row.stepsTotal}
                        </span>
                        {row.nextStep ? (
                          <div className="mt-0.5 fh-tiny fh-accent">Next: {row.nextStep}</div>
                        ) : null}
                      </td>
                      <td data-label="Status">
                        <StatusPill row={row} />
                      </td>
                      <td data-label="Detected" className="fh-nowrap">
                        <div className="fh-tiny fh-faint">{row.detectedAgo}</div>
                        <div className="mt-0.5 fh-tiny fh-faint">{row.detectedDate}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
