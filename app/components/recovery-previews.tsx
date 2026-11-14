import { Icon, iconAlert, iconPercent, iconTrendingUp } from "capsomer/react/icons";
import { plural } from "@drdustinedwards/site-helpers/text";
import { Table } from "capsomer/react/table";
import { Pill, Status, type Tone } from "capsomer/react/status";
import { Link } from "capsomer/react/link";
import "capsomer/step-indicator.css";

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
          <div className="fh-recprev-block fh-tiny fh-medium fh-quiet fh-caps-wide">
            {label}: {count}
          </div>
          {/* Recova's row scrolls sideways on a narrow screen; Capsomer's inline steps wrap instead,
              since no page may need a sideways scrollbar (Dustin, 2026-10-30). */}
          <div className="cap-steps fh-recprev-block-2" data-variant="inline">
            <ol aria-label={`${label} sequence, ${count}`} className="cap-steps-list">
              {steps.map((step) => (
                <li key={step.stepType} className="cap-step">
                  <StepChip
                    retry={isRetryStep(step.stepType)}
                    timing={timingLabel(step.offsetHours)}
                  />
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CategorySequencePreview() {
  return (
    <div className="cap-stack fh-recprev-block-3" data-gap="5">
      {CATEGORIES.map((category) => (
        <div key={category} data-category={category}>
          <div className="fh-recprev-row">
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
  caution: { tone: "warn", className: "fh-caution" },
  red: { tone: "crit", className: "fh-error" },
};

function Figure({
  icon,
  label,
  value,
  className,
  sub,
}: {
  icon: string;
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
          <Icon d={icon} className={`fh-recprev-icon fh-icon-16 fh-icon-fine ${className}`} />
          <p className="fh-recprev-text fh-tiny fh-medium fh-quiet">{label}</p>
          <p className={`fh-recprev-text-2 fh-mono fh-display fh-bold ${className}`}>{value}</p>
          {sub ? <div className="fh-recprev-block-4 fh-tiny">{sub}</div> : null}
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
      <h4 className="fh-mk-kicker-gap fh-tiny fh-medium fh-quiet">{heading}</h4>
      <dl className="cap-stack" data-gap="3">
        {rows.map(([label, value, kind]) => (
          <div key={label} className="fh-recprev-row-2">
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
    <div className="fh-recprev-block-3">
      <ul className="fh-recprev-grid" aria-label="Recovery figures">
        <Figure
          icon={iconTrendingUp}
          label="Recovered (30d)"
          value={dashboard.recovered30d}
          className="fh-success"
        />
        <Figure
          icon={iconAlert}
          label="Currently at risk"
          value={dashboard.atRisk}
          className="fh-error"
        />
        <Figure
          icon={iconPercent}
          label="Recovery rate"
          value={dashboard.ratePct === null ? "-" : `${dashboard.ratePct}%`}
          className={rate?.className ?? "fh-faint"}
          sub={<Status tone={rate?.tone ?? "nodata"}>{dashboard.rateBand}</Status>}
        />
      </ul>
      <div className="cap-panel">
        <div className="cap-panel-body">
          <div className="fh-recprev-grid-2">
            <div className="fh-recprev-block-5">
              <RoiRows
                heading="This month"
                rows={[
                  ["Recovered by Foxhound", month.recovered, "plain"],
                  [`Foxhound fee (${roi.feePct}%)`, month.fee, "fee"],
                  ["You kept", month.kept, "net"],
                ]}
              />
            </div>
            <div className="fh-recprev-block-6">
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
    <div className="fh-recprev-block-3">
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
          <ul className="fh-recprev-list-2">
            {rows.map((row) => (
              <li key={row.id} className="fh-recprev-item">
                <div className="fh-mk-card-top">
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
          <div className="fh-recprev-block-7">
            <Table caption="Failed payments" captionHidden labelledBy={HEADING_ID} reflow>
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
                        <div className="fh-recprev-block-8 fh-tiny fh-regular fh-faint">
                          {row.email}
                        </div>
                      ) : null}
                      {row.plan ? (
                        <div className="fh-recprev-block-8 fh-tiny fh-regular fh-faint">
                          {row.plan}
                        </div>
                      ) : null}
                    </th>
                    <td data-label="Amount" className="fh-nowrap">
                      <span className="fh-mono fh-small fh-accent">{row.amount}</span>
                    </td>
                    <td data-label="Decline">
                      <CategoryPill category={row.category} />
                      {row.declineCode ? (
                        <div className="fh-recprev-block-4 fh-mono fh-tiny fh-faint">
                          {row.declineCode}
                        </div>
                      ) : null}
                    </td>
                    <td data-label="Steps">
                      <span
                        className={`fh-mono fh-tiny ${row.stepsDone > 0 ? "fh-text" : "fh-faint"}`}
                      >
                        {row.stepsDone}/{row.stepsTotal}
                      </span>
                      {row.nextStep ? (
                        <div className="fh-recprev-block-8 fh-tiny fh-accent">
                          Next: {row.nextStep}
                        </div>
                      ) : null}
                    </td>
                    <td data-label="Status">
                      <StatusPill row={row} />
                    </td>
                    <td data-label="Detected" className="fh-nowrap">
                      <div className="fh-tiny fh-faint">{row.detectedAgo}</div>
                      <div className="fh-recprev-block-8 fh-tiny fh-faint">{row.detectedDate}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </div>
      </section>
    </div>
  );
}
