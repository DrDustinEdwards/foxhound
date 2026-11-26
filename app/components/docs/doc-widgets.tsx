import { Icon, iconActivity, iconCard, iconScale, iconWarning } from "capsomer/react/icons";
import { titleCase } from "@drdustinedwards/site-helpers/text";
import { FeatureGrid } from "capsomer/react/feature";
import { ProcessSteps } from "capsomer/react/process";
import { Table } from "capsomer/react/table";
import { Pill, type Tone } from "capsomer/react/status";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";

import { CategoryPill } from "~/components/tone-pills";
import { SequenceSteps, timingLabel } from "~/components/recovery-previews";
import { HEALTH_SCORE_AT_RISK_THRESHOLD, type DeclineCategory } from "~/lib/constants";
import { DISPUTE_STATE_LABELS } from "~/lib/disputes/labels";
import { WATCH_CEILING } from "~/lib/intelligence/health-band";
import {
  DECLINE_CATEGORY_LABELS,
  FAILED_PAYMENT_STATUS_LABELS,
  formatStepType,
} from "~/lib/recovery/labels";
import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";

import { HealthScoreBadge } from "./health-score-badge";

import "capsomer/feature-grid.css";
import "capsomer/panel.css";
import "capsomer/process.css";
import "capsomer/status.css";
import "capsomer/stat-tile.css";
import "capsomer/table.css";

// The docs preview widgets, on Capsomer's parts. Static markup, no loader, no DB. Where a widget shows a set Foxhound already defines (the decline categories, the payment statuses, the dispute states, the recovery schedules, the health bands), it derives that set from the constant rather than transcribing it, so a seventh decline category changes the picture the day it lands. Widgets that would print invented customers and money are not drawn: a guide page has no loader to read the demo seed through.

/** The four audit scope cards, as Capsomer's feature cards in a two-column grid, saying what Foxhound's engine computes for each (app/lib/audit/engine.ts). */
function AuditScopes() {
  const scopes: [string, string, string][] = [
    [
      iconWarning,
      "Failed invoices",
      "Unrecovered failed invoices, their total, and the decline category behind each",
    ],
    [
      iconCard,
      "Expiring cards",
      "Cards that have expired or expire this month or next, and the MRR at risk",
    ],
    [
      iconScale,
      "Open disputes",
      "Open disputes, disputes lost with no evidence, and your won and lost record",
    ],
    [iconActivity, "Business health", "MRR, ARR, active subscriptions, and churn rate"],
  ];
  return (
    <div className="fh-my-6">
      <FeatureGrid
        items={scopes.map(([icon, title, text]) => ({
          icon: <Icon d={icon} className="fh-icon-175" />,
          title,
          text,
        }))}
      />
    </div>
  );
}

/** Status pills from `FAILED_PAYMENT_STATUS_LABELS`, so the fifth status (Stripe retrying) is drawn and the last one reads "Failed", the tab word. */
const STATUS_PILL: Record<
  string,
  { tone?: Tone; variant?: "outline" | "secondary"; caption: string }
> = {
  stripe_retrying: { variant: "outline", caption: "Stripe is still retrying" },
  active: { tone: "info", caption: "Sequence running" },
  recovered: { tone: "ok", caption: "Invoice paid" },
  cancelled: { variant: "secondary", caption: "Stopped by you, or the subscription ended" },
  failed_unrecovered: { tone: "crit", caption: "All steps ran, no recovery" },
};

function PaymentStatuses() {
  return (
    <div className="fh-my-5 cap-panel">
      <div className="cap-panel-body">
        <ul className="fh-doc-widgets-list">
          {Object.entries(FAILED_PAYMENT_STATUS_LABELS).map(([key, label]) => {
            const pill = STATUS_PILL[key] ?? { variant: "outline" as const, caption: "" };
            return (
              <li key={key} className="fh-doc-widgets-item">
                <Pill tone={pill.tone} variant={pill.variant}>
                  {label}
                </Pill>
                <span className="fh-tiny fh-quiet">{pill.caption}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** One card per category with the decline codes that land in it. Every code named here is checked against classifyDecline by test/docs.test.ts. */
const CATEGORY_CODES: Record<DeclineCategory, { codes: string[]; note: string }> = {
  soft: {
    codes: ["insufficient_funds", "do_not_honor", "generic_decline"],
    note: "The card is good, the charge was refused for now",
  },
  network: {
    codes: ["processing_error", "issuer_not_available", "try_again_later"],
    note: "A processor or bank problem, usually passing",
  },
  expired: { codes: ["expired_card"], note: "The card has passed its expiry date" },
  fraud: { codes: ["stolen_card", "lost_card", "fraudulent"], note: "The issuer blocked the card" },
  revoked: { codes: ["revocation_of_authorization"], note: "The customer withdrew the mandate" },
  unknown: { codes: [], note: "A decline code none of the five above lists, or none at all" },
};

function DeclineCategories() {
  return (
    <ul className="fh-doc-widgets-grid">
      {(Object.keys(CATEGORY_CODES) as DeclineCategory[]).map((category) => {
        const { codes, note } = CATEGORY_CODES[category];
        return (
          <li key={category} data-category={category} className="cap-panel">
            <div className="cap-panel-body">
              <div className="fh-mk-point-wide">
                <CategoryPill category={category} />
                <span className="fh-doc-widgets-label fh-small fh-relaxed fh-soft">
                  <span className="fh-medium fh-text">{DECLINE_CATEGORY_LABELS[category]}.</span>{" "}
                  {note}
                  {codes.length > 0 ? ": " : null}
                  {codes.map((code, i) => (
                    <span key={code}>
                      {i > 0 ? ", " : null}
                      <code className="fh-break fh-mono">{code}</code>
                    </span>
                  ))}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** One SequenceTimeline per category, from RECOVERY_SCHEDULES through the same part /product/recovery draws, so the guide and the product page cannot disagree. Silent retry first where the category allows a retry at all. */
function SequenceTimelines() {
  return (
    <div className="cap-stack fh-my-6" data-gap="4">
      {(Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[]).map((category) => (
        <SequenceSteps key={category} category={category} />
      ))}
    </div>
  );
}

/** One payment's steps with their result, labeled an example, from the soft schedule and worded as the payment page does (formatStepType). */
function PaymentTimeline() {
  const steps = RECOVERY_SCHEDULES.soft;
  return (
    <div className="fh-my-6 cap-panel">
      <div className="cap-panel-body" data-flush>
        <div className="fh-doc-widgets-row">
          <span className="fh-small fh-medium fh-text">Example: a soft decline</span>
          <CategoryPill category="soft" />
        </div>
        <ProcessSteps
          layout="rows"
          flush
          headingLevel="p"
          steps={steps.map((step, i) => ({
            id: step.stepType,
            title: formatStepType(step.stepType),
            end: (
              <>
                <span className="fh-nowrap fh-mono fh-tiny fh-quiet">
                  {timingLabel(step.offsetHours)}
                </span>
                {i === 0 && isRetryStep(step.stepType) ? (
                  <Pill tone="crit">{titleCase("retry_failed")}</Pill>
                ) : (
                  <Pill variant="secondary">Pending</Pill>
                )}
              </>
            ),
          }))}
        />
      </div>
    </div>
  );
}

/** The three health bands at Foxhound's cutoffs, drawn from the constants the scorer uses. */
function HealthBands() {
  const last = WATCH_CEILING - 1;
  return (
    <div className="fh-my-6">
      <StatTiles label="Health bands">
        <StatTile
          label="Health score"
          tone="crit"
          word="At risk"
          figure={`Below ${HEALTH_SCORE_AT_RISK_THRESHOLD}`}
        />
        <StatTile
          label="Health score"
          tone="warn"
          word="Watch"
          figure={`${HEALTH_SCORE_AT_RISK_THRESHOLD} to ${last}`}
        />
        <StatTile
          label="Health score"
          tone="ok"
          word="Healthy"
          figure={`${WATCH_CEILING} and above`}
        />
      </StatTiles>
    </div>
  );
}

/** The customers page's columns in its order, with a badge in each band in the Health row, rather than invented customers. */
function CustomerColumns() {
  const examples = [
    HEALTH_SCORE_AT_RISK_THRESHOLD - 15,
    HEALTH_SCORE_AT_RISK_THRESHOLD + 10,
    WATCH_CEILING + 12,
  ];
  const columns: [string, React.ReactNode][] = [
    ["Customer", "Name and email, from Stripe."],
    ["Plan", "The current plan."],
    ["MRR", "What that customer contributes each month."],
    [
      "Health",
      <span key="h" className="fh-doc-widgets-row-2">
        The 0 to 100 score, in its band:
        {examples.map((s) => (
          <HealthScoreBadge key={s} score={s} />
        ))}
      </span>,
    ],
    ["Last seen", "When the customer was last active."],
    ["Signals", "Marks for an active recovery and a dispute history."],
  ];
  return (
    <Table caption="Customers page columns" captionHidden reflow className="fh-my-6">
      <thead>
        <tr>
          <th scope="col">Column</th>
          <th scope="col">What it shows</th>
        </tr>
      </thead>
      <tbody>
        {columns.map(([name, description]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td data-label="What it shows">{description}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** The dispute states in order, from `DISPUTE_STATE_LABELS`; they are what Foxhound's approval gate turns on. */
function DisputeStates() {
  const meaning: Record<string, string> = {
    draft: "Evidence is being assembled. Nothing has been submitted.",
    pending_review: "Evidence is ready and waiting for a person on your team.",
    approved: "Somebody approved it, and it is being sent to Stripe.",
    submitted: "Sent to Stripe. Waiting on the issuer.",
    resolved_won: "The issuer found for you.",
    resolved_lost: "The issuer found for the cardholder.",
    inquiry_closed:
      "An inquiry Stripe closed with no chargeback. Nothing was won or lost, and nothing is billed.",
  };
  return (
    <div className="fh-my-6">
      <ProcessSteps
        layout="rows"
        headingLevel="p"
        steps={Object.entries(DISPUTE_STATE_LABELS).map(([key, label]) => ({
          id: key,
          title: <Pill variant="outline">{label}</Pill>,
          text: meaning[key] ?? "",
        }))}
      />
    </div>
  );
}

const WIDGETS = {
  "audit-scopes": AuditScopes,
  "payment-statuses": PaymentStatuses,
  "payment-timeline": PaymentTimeline,
  "decline-categories": DeclineCategories,
  "sequence-timelines": SequenceTimelines,
  "health-bands": HealthBands,
  "customer-columns": CustomerColumns,
  "dispute-states": DisputeStates,
} as const;

export type DocWidgetName = keyof typeof WIDGETS;

export function DocWidget({ name }: { name: DocWidgetName }) {
  const Component = WIDGETS[name];
  return <Component />;
}

/** Exported so a plant can assert the bands the picture draws are the bands the
 *  engine computes, rather than trusting two hand-kept lists to agree. */
