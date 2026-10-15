import { AlertTriangle, CreditCard, Scale, Activity } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Pill, type Tone } from "capsomer/react/status";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";

import { SequenceSteps } from "~/components/recovery-previews";
import { timingLabel } from "~/components/docs/sequence-timeline";
import { HEALTH_SCORE_AT_RISK_THRESHOLD, type DeclineCategory } from "~/lib/constants";
import { DISPUTE_STATE_LABELS } from "~/lib/disputes/labels";
import { WATCH_CEILING, healthScoreBand } from "~/lib/intelligence/health-band";
import { CATEGORY_PILL_WORDS } from "~/lib/marketing/recovery-copy";
import { DECLINE_CATEGORY_LABELS, FAILED_PAYMENT_STATUS_LABELS, formatStepResult, formatStepType } from "~/lib/recovery/labels";
import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";

import { HealthScoreBadge } from "./health-score-badge";

import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/stat-tile.css";
import "capsomer/table.css";

// The docs preview widgets: Recova's components/docs/* illustrations (J73), on
// Capsomer's parts (Q12).
//
// STATIC MARKUP, NO LOADER, NO DB. Where a widget shows a set Foxhound already
// defines (the decline categories, the payment statuses, the dispute states, the
// recovery schedules, the health bands), it DERIVES that set from the constant
// rather than transcribing it, so a seventh decline category changes the
// picture the day it lands.
//
// RECOVA'S WIDGETS NOT DRAWN, each for a reason in the PR:
//   PaymentsTablePreview, DashboardStatCards and ChurnRiskSummary print the
//     Teamflow demo's customers and money; Foxhound's figures for these come
//     from its own demo seed through a loader, which a guide page does not have.
//   DisputesTablePreview and TriagePill: `triage_recommendation` has no producer
//     outside the demo seeder, so a Triage column would document a feature that
//     does not exist.

/** Recova's four audit scope cards (AuditScopeCard, blob `dc1d18dd`), at its
 *  two-column grid, saying what Foxhound's engine computes for each
 *  (app/lib/audit/engine.ts). Recova's text glyphs become drawn icons, as on
 *  the app's step icons (APPROVED-DIFFERENCES, 2026-08-15). */
function AuditScopes() {
  const scopes: [LucideIcon, string, string][] = [
    [AlertTriangle, "Failed invoices", "Unrecovered failed invoices, their total, and the decline category behind each"],
    [CreditCard, "Expiring cards", "Cards that have expired or expire this month or next, and the MRR at risk"],
    [Scale, "Open disputes", "Open disputes, disputes lost with no evidence, and your won and lost record"],
    [Activity, "Business health", "MRR, ARR, active subscriptions, and churn rate"],
  ];
  return (
    <div className="my-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {scopes.map(([Icon, title, description]) => (
        <div key={title} className="cap-panel">
          <div className="cap-panel-body">
            <div className="flex items-start gap-3">
              <Icon className="mt-0.5 shrink-0 text-accent-text" size={18} strokeWidth={1.75} aria-hidden />
              <div>
                <div className="mb-1 text-label font-medium text-text">{title}</div>
                <div className="text-label leading-relaxed text-text-secondary">{description}</div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Recova's StatusPillShowcase (blob `37614382`), from
 *  `FAILED_PAYMENT_STATUS_LABELS`, so Foxhound's fifth status (Stripe
 *  retrying, 377) is drawn and the last one reads "Failed", the tab word. */
const STATUS_PILL: Record<string, { tone?: Tone; variant?: "outline" | "secondary"; caption: string }> = {
  stripe_retrying: { variant: "outline", caption: "Stripe is still retrying" },
  active: { tone: "info", caption: "Sequence running" },
  recovered: { tone: "ok", caption: "Invoice paid" },
  cancelled: { variant: "secondary", caption: "Stopped by you, or the subscription ended" },
  failed_unrecovered: { tone: "crit", caption: "All steps ran, no recovery" },
};

function PaymentStatuses() {
  return (
    <div className="cap-panel my-4">
      <div className="cap-panel-body">
        <ul className="m-0 flex list-none flex-wrap gap-4 p-0">
          {Object.entries(FAILED_PAYMENT_STATUS_LABELS).map(([key, label]) => {
            const pill = STATUS_PILL[key] ?? { variant: "outline" as const, caption: "" };
            return (
              <li key={key} className="flex flex-col items-center gap-1.5">
                <Pill tone={pill.tone} variant={pill.variant}>
                  {label}
                </Pill>
                <span className="text-micro text-text-tertiary">{pill.caption}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Recova's CategoryPillShowcase (blob `62a8a9e1`): one card per category with
 *  the decline codes that land in it. SIX, not Recova's four. Every code named
 *  here is checked against classifyDecline by test/docs-guides-j73.test.ts. */
const CATEGORY_CODES: Record<DeclineCategory, { codes: string[]; note: string }> = {
  soft: { codes: ["insufficient_funds", "do_not_honor", "generic_decline"], note: "The card is good, the charge was refused for now" },
  network: { codes: ["processing_error", "issuer_not_available", "try_again_later"], note: "A processor or bank problem, usually passing" },
  expired: { codes: ["expired_card"], note: "The card has passed its expiry date" },
  fraud: { codes: ["stolen_card", "lost_card", "fraudulent"], note: "The issuer blocked the card" },
  revoked: { codes: ["revocation_of_authorization"], note: "The customer withdrew the mandate" },
  unknown: { codes: [], note: "A decline code none of the five above lists, or none at all" },
};

function DeclineCategories() {
  return (
    <ul className="my-4 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
      {(Object.keys(CATEGORY_CODES) as DeclineCategory[]).map((category) => {
        const { codes, note } = CATEGORY_CODES[category];
        return (
          <li key={category} data-category={category} className="cap-panel">
            <div className="cap-panel-body">
              <div className="flex items-start gap-3">
                <Pill variant="outline">{CATEGORY_PILL_WORDS[category]}</Pill>
                <span className="text-label leading-relaxed text-text-secondary">
                  <span className="font-medium text-text">{DECLINE_CATEGORY_LABELS[category]}.</span>{" "}
                  {note}
                  {codes.length > 0 ? ": " : null}
                  {codes.map((code, i) => (
                    <span key={code}>
                      {i > 0 ? ", " : null}
                      <code className="font-mono">{code}</code>
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

/** Recova's four SequenceTimelines (blob `aa6a85fc`), one per category, from
 *  RECOVERY_SCHEDULES through the same part /product/recovery draws, so the
 *  guide and the product page cannot disagree. Six categories, silent retry
 *  first where the category allows a retry at all. */
function SequenceTimelines() {
  return (
    <div className="my-6 flex flex-col gap-3">
      {(Object.keys(RECOVERY_SCHEDULES) as DeclineCategory[]).map((category) => (
        <SequenceSteps key={category} category={category} />
      ))}
    </div>
  );
}

/** Recova's PaymentTimelinePreview (blob `be6fb312`): one payment's steps with
 *  their result. Recova's rows name a demo customer and raw step types
 *  ("retry_4hr"); this one is labelled an example, takes its steps from the
 *  soft schedule, and words them as the payment page does (formatStepType). */
function PaymentTimeline() {
  const steps = RECOVERY_SCHEDULES.soft;
  return (
    <div className="cap-panel my-6">
      <div className="cap-panel-body" data-flush>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <span className="text-label font-medium text-text">Example: a soft decline</span>
          <Pill variant="outline">{CATEGORY_PILL_WORDS.soft}</Pill>
        </div>
        <ol className="m-0 list-none divide-y divide-border p-0">
          {steps.map((step, i) => (
            <li key={step.stepType} className="flex items-center gap-4 px-4 py-3">
              <span className="w-6 font-mono text-micro text-text-tertiary">{i + 1}</span>
              <span className="flex-1 truncate text-label text-text-secondary">{formatStepType(step.stepType)}</span>
              <span className="whitespace-nowrap font-mono text-micro text-text-tertiary">
                {timingLabel(step.offsetHours)}
              </span>
              {i === 0 && isRetryStep(step.stepType) ? (
                <Pill tone="crit">{formatStepResult("retry_failed")}</Pill>
              ) : (
                <Pill variant="secondary">Pending</Pill>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** The three health bands at Foxhound's cutoffs, in place of Recova's
 *  ChurnRiskSummary (blob `ba1fbb51`), whose figures are the Teamflow demo's.
 *  Drawn from the constants the scorer uses. */
function HealthBands() {
  const last = WATCH_CEILING - 1;
  return (
    <div className="my-6">
      <StatTiles label="Health bands">
        <StatTile label="At risk" tone="crit" word="At risk" figure={`Below ${HEALTH_SCORE_AT_RISK_THRESHOLD}`} />
        <StatTile label="Watch" tone="warn" word="Watch" figure={`${HEALTH_SCORE_AT_RISK_THRESHOLD} to ${last}`} />
        <StatTile label="Healthy" tone="ok" word="Healthy" figure={`${WATCH_CEILING} and above`} />
      </StatTiles>
    </div>
  );
}

/** Recova's IntelligenceCustomerTable (blob `6ae7c73f`) shows five demo
 *  customers with an Action column. Foxhound's customers page has no Action
 *  column (`ai_recommended_actions` has no writer) and carries Last seen and
 *  Signals, so this draws the page's columns in its order, with a badge in each
 *  band in the Health row, rather than invented customers. */
function CustomerColumns() {
  const examples = [HEALTH_SCORE_AT_RISK_THRESHOLD - 15, HEALTH_SCORE_AT_RISK_THRESHOLD + 10, WATCH_CEILING + 12];
  const columns: [string, React.ReactNode][] = [
    ["Customer", "Name and email, from Stripe."],
    ["Plan", "The current plan."],
    ["MRR", "What that customer contributes each month."],
    [
      "Health",
      <span key="h" className="inline-flex flex-wrap items-center gap-2">
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
    <div className="cap-table-wrap my-6" data-cap="table" role="region" aria-label="Customers page columns" tabIndex={0}>
      <table className="cap-table">
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
              <td>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The dispute states in order, from `DISPUTE_STATE_LABELS`. Recova's
 *  DisputesTablePreview mocks a list with a Triage column Foxhound does not
 *  have; the states are what Foxhound's approval gate turns on. */
function DisputeStates() {
  const meaning: Record<string, string> = {
    draft: "Evidence is being assembled. Nothing has been submitted.",
    pending_review: "Evidence is ready and waiting for a person on your team.",
    approved: "Somebody approved it, and it is being sent to Stripe.",
    submitted: "Sent to Stripe. Waiting on the issuer.",
    resolved_won: "The issuer found for you.",
    resolved_lost: "The issuer found for the cardholder.",
  };
  return (
    <ol className="my-6 flex list-none flex-col gap-2 p-0">
      {Object.entries(DISPUTE_STATE_LABELS).map(([key, label], i) => (
        <li key={key} className="cap-panel">
          <div className="cap-panel-body">
            <div className="flex items-start gap-3">
              <span className="shrink-0 font-mono text-micro text-accent-text">{String(i + 1).padStart(2, "0")}</span>
              <div className="flex flex-col items-start gap-1">
                <Pill variant="outline">{label}</Pill>
                <span className="text-label leading-relaxed text-text-secondary">{meaning[key] ?? ""}</span>
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
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

export const DOC_WIDGET_NAMES = Object.keys(WIDGETS) as DocWidgetName[];

export function DocWidget({ name }: { name: DocWidgetName }) {
  const Component = WIDGETS[name];
  return <Component />;
}

/** Exported so a plant can assert the bands the picture draws are the bands the
 *  engine computes, rather than trusting two hand-kept lists to agree. */
export { healthScoreBand };
