import { AlertCircle, Percent, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Pill, Status, type Tone } from "capsomer/react/status";
import { Link } from "react-router";

import { CategoryPill, StepChip } from "~/components/tone-pills";
import { timingLabel } from "~/components/docs/sequence-timeline";
import type { DeclineCategory } from "~/lib/constants";
import type { RecoveryRateTone } from "~/lib/dashboard/recovery-rate";
import type { PreviewPaymentRow, RecoveryPreview, RoiColumn } from "~/lib/marketing/recovery-preview";
import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { isRetryStep, RECOVERY_SCHEDULES } from "~/lib/recovery/schedule";

// The three previews on /product/recovery (J56), Recova's three feature-block
// UIs: the category sequences (page.tsx's CategorySequencePreview with
// CategoryPill and SequenceTimeline), the dashboard (RecoveryDashboardPreview:
// StatCards' primary row and ROIWidget) and the payments table
// (RecoveryPaymentsPreview: PaymentsTable and PaymentRow's preview row).
//
// Content and layout are Recova's; the parts are Capsomer's (Q12). The
// sequences are read from RECOVERY_SCHEDULES and every figure from the demo
// seed (app/lib/marketing/recovery-preview.server.ts), never a merchant's rows.
// Recova draws no chart in any of the three, so neither does this page.

const CATEGORIES = Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[];

export function SequenceSteps({ category }: { category: DeclineCategory }) {
  const steps = RECOVERY_SCHEDULES[category];
  const label = DECLINE_CATEGORY_LABELS[category];
  const count = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  return (
    <div className="cap-panel">
      <div className="cap-panel-body">
        <div>
          <div className="mb-3 text-micro font-medium uppercase tracking-widest text-text-tertiary">
            {label}: {count}
          </div>
          {/* Recova's row scrolls sideways on a narrow screen; a window that
              scrolls is a keyboard stop, named for what it holds. */}
          <div role="region" aria-label={`${label} sequence, ${count}`} tabIndex={0} className="overflow-x-auto pb-2">
            <ol className="m-0 flex min-w-max list-none items-center gap-1 p-0">
              {steps.map((step, i) => {
                const retry = isRetryStep(step.stepType);
                return (
                  <li key={step.stepType} className="flex items-center gap-1">
                    <StepChip retry={retry} timing={timingLabel(step.offsetHours)} />
                    {i < steps.length - 1 ? (
                      <span className="h-px w-4 shrink-0 bg-border" aria-hidden="true" />
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
            <span className="font-mono text-label text-text-tertiary">{DECLINE_CATEGORY_LABELS[category]} sequence</span>
          </div>
          <SequenceSteps category={category} />
        </div>
      ))}
    </div>
  );
}

const RATE_STATUS: Record<RecoveryRateTone, { tone: Tone; className: string }> = {
  green: { tone: "ok", className: "text-success-text" },
  caution: { tone: "warn", className: "text-caution" },
  red: { tone: "crit", className: "text-error-text" },
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
          <p className="m-0 mb-2 text-micro font-medium text-text-tertiary">{label}</p>
          <p className={`m-0 font-mono text-display font-bold tracking-[-0.5px] ${className}`}>{value}</p>
          {sub ? <div className="mt-1 text-micro">{sub}</div> : null}
        </div>
      </div>
    </li>
  );
}

function RoiRows({ heading, rows }: { heading: string; rows: [string, string, "plain" | "fee" | "net"][] }) {
  return (
    <div>
      <h4 className="m-0 mb-3 text-micro font-medium uppercase tracking-[0.06em] text-text-tertiary">{heading}</h4>
      <dl className="m-0 flex flex-col gap-2">
        {rows.map(([label, value, kind]) => (
          <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <dt className={`text-label ${kind === "fee" ? "text-text-tertiary" : "text-text-secondary"}`}>{label}</dt>
            <dd
              className={`m-0 font-mono text-body tabular-nums ${
                kind === "net" ? "font-bold text-success-text" : kind === "fee" ? "text-text-tertiary" : "text-text"
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
      <ul className="m-0 mb-5 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-3" aria-label="Recovery figures">
        <Figure icon={TrendingUp} label="Recovered (30d)" value={dashboard.recovered30d} className="text-success-text" />
        <Figure icon={AlertCircle} label="Currently at risk" value={dashboard.atRisk} className="text-error-text" />
        <Figure
          icon={Percent}
          label="Recovery rate"
          value={dashboard.ratePct === null ? "-" : `${dashboard.ratePct}%`}
          className={rate?.className ?? "text-text-subtle"}
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
          <ul className="m-0 list-none p-0 sm:hidden">
            {rows.map((row) => (
              <li key={row.id} className="border-b border-border px-5 py-4 last:border-b-0">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-label font-medium text-text">{row.customer}</div>
                    {row.email ? <div className="truncate text-micro text-text-subtle">{row.email}</div> : null}
                  </div>
                  <span className="whitespace-nowrap font-mono text-label text-accent-text">{row.amount}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <CategoryPill category={row.category} />
                  <StatusPill row={row} />
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
            <div className="cap-table-wrap" role="region" aria-labelledby={HEADING_ID} tabIndex={0}>
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
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-label font-medium text-text">{row.customer}</span>
                          <FailureCount row={row} />
                        </div>
                        {row.email ? <div className="mt-0.5 text-micro font-normal text-text-subtle">{row.email}</div> : null}
                        {row.plan ? <div className="mt-0.5 text-micro font-normal text-text-subtle">{row.plan}</div> : null}
                      </th>
                      <td className="whitespace-nowrap">
                        <span className="font-mono text-label text-accent-text">{row.amount}</span>
                      </td>
                      <td>
                        <CategoryPill category={row.category} />
                        {row.declineCode ? (
                          <div className="mt-1 font-mono text-micro text-text-subtle">{row.declineCode}</div>
                        ) : null}
                      </td>
                      <td>
                        <span className={`font-mono text-micro ${row.stepsDone > 0 ? "text-text" : "text-text-subtle"}`}>
                          {row.stepsDone}/{row.stepsTotal}
                        </span>
                        {row.nextStep ? (
                          <div className="mt-0.5 text-micro text-accent-text">Next: {row.nextStep}</div>
                        ) : null}
                      </td>
                      <td>
                        <StatusPill row={row} />
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="text-micro text-text-subtle">{row.detectedAgo}</div>
                        <div className="mt-0.5 text-micro text-text-subtle">{row.detectedDate}</div>
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
