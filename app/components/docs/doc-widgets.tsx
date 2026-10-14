import { Badge } from "~/components/badge";
import { WATCH_CEILING, healthScoreBand } from "~/lib/intelligence/health-band";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { DISPUTE_STATE_LABELS } from "~/lib/disputes/labels";
import { DECLINE_CATEGORY_LABELS, FAILED_PAYMENT_STATUS_LABELS } from "~/lib/recovery/labels";
import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";

// The docs preview widgets, ruled by the session 65 walk.
//
// STATIC MARKUP, NO LOADER, NO DB. Where a widget shows a set Foxhound already
// defines (the decline categories, the payment statuses, the dispute states, the
// recovery schedules), it DERIVES that set from the constant rather than
// transcribing it. A compile-time constant is not live data, and deriving means
// a seventh decline category or a new dispute state changes the docs picture the
// day it lands instead of leaving a mock that quietly disagrees with the product.
//
// WHAT IS NOT HERE, and why, from the walk:
//   TriagePill and DisputesTablePreview's triage column: `triage_recommendation`
//     has no producer outside the demo seeder, so a pill for it would document a
//     feature that does not exist.
//   DashboardStatCards: its entire content is invented money plus legacy's
//     "21-35%: at or near average" threshold band, which the heading map already
//     records as NOT PORTABLE. The recovery guide's nine-row table says the same
//     thing truthfully.
//   PaymentsTablePreview and PaymentTimelinePreview: both are fabricated-row
//     mocks whose real informational content is the step-type set, and
//     SequenceTimeline below carries that derived from the engine.

const CARD = "rounded-lg border border-border bg-surface p-4";
const CARD_LABEL = "mb-1 text-micro uppercase tracking-widest text-text-tertiary";

/** Legacy's four audit scope cards (blob `dc1d18dd`), at its two-column grid.
 *  REDRAWN IN SESSION 66 with /audit's restated copy under ruling 360. Session
 *  65 built it as a BUILD, taking /audit's four scope names on the grounds that
 *  the page and the docs should agree. They still agree; the page moved. Legacy
 *  computes all four scopes in runAudit and Foxhound computes none, so both
 *  surfaces now name what exists rather than what an audit would cover.
 *
 *  BUSINESS HEALTH IS THE ONE TOPIC THAT DID NOT SURVIVE: Foxhound has MRR and
 *  its movement, and no ARR, no active-subscription count and no churn in basis
 *  points. */
function AuditScopes() {
  const scopes: [string, string][] = [
    [
      "Failed payments",
      "Every failed payment Foxhound has detected, what came back, and what is still unrecovered.",
    ],
    [
      "Expiring cards",
      "Cards inside thirty days of expiring, and the customers Foxhound has already emailed about them.",
    ],
    ["Open disputes", "Chargebacks still waiting on evidence, with the deadline on each one."],
    [
      "MRR and movement",
      "Monthly recurring revenue, what is at risk, and the new, expansion and churn behind the total.",
    ],
  ];
  return (
    <div className="my-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {scopes.map(([title, description]) => (
        <div key={title} className={CARD}>
          <div className="mb-1 text-label font-medium text-text">{title}</div>
          <div className="text-caption leading-relaxed text-text-secondary">{description}</div>
        </div>
      ))}
    </div>
  );
}

/** The four payment statuses, from `FAILED_PAYMENT_STATUS_LABELS`. Legacy's
 *  showcase hardcodes them and calls the last one "Failed unrecovered"; the tab
 *  word on both sides is "Failed", which is what the label map carries. */
function PaymentStatuses() {
  const meaning: Record<string, string> = {
    active: "Sequence running",
    recovered: "Invoice paid",
    cancelled: "Stopped by you, or the subscription ended",
    failed_unrecovered: "Every step ran, no recovery",
  };
  const tone: Record<string, "neutral" | "success" | "failure"> = {
    active: "neutral",
    recovered: "success",
    cancelled: "neutral",
    failed_unrecovered: "failure",
  };
  return (
    <div className={`my-4 flex flex-wrap gap-4 ${CARD}`}>
      {Object.entries(FAILED_PAYMENT_STATUS_LABELS).map(([key, label]) => (
        <div key={key} className="flex flex-col items-center gap-1.5">
          <Badge tone={tone[key] ?? "neutral"}>{label}</Badge>
          <span className="text-caption text-text-tertiary">{meaning[key] ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

/** The decline categories, from `DECLINE_CATEGORY_LABELS`. SIX, not legacy's
 *  four: the redraw is the point, since a four-pill picture beside a six-key
 *  engine is the same defect the recovery guide's own sentence carried. */
function DeclineCategories() {
  return (
    <div className={`my-4 flex flex-wrap gap-3 ${CARD}`}>
      {Object.entries(DECLINE_CATEGORY_LABELS).map(([key, label]) => (
        <div key={key} className="flex flex-col gap-1">
          <Badge tone="neutral">{label}</Badge>
          <span className="text-center font-mono text-caption text-text-tertiary">{key}</span>
        </div>
      ))}
    </div>
  );
}

/** One row per decline category, each step in schedule order, derived from
 *  `RECOVERY_SCHEDULES`. Legacy's SequenceTimeline (blob `aa6a85fc`) hardcodes
 *  four categories and puts an email first on every one; Foxhound is
 *  silent-retry-first where the category allows a retry at all. */
function SequenceTimelines() {
  return (
    <div className="my-6 flex flex-col gap-3">
      {Object.entries(RECOVERY_SCHEDULES).map(([category, steps]) => (
        <div key={category} className={CARD}>
          <div className={CARD_LABEL}>
            {DECLINE_CATEGORY_LABELS[category as keyof typeof DECLINE_CATEGORY_LABELS]}
            {": "}
            {steps.length === 1 ? "1 step" : `${steps.length} steps`}
          </div>
          <div className="overflow-x-auto pb-2">
            <div className="flex min-w-max items-center gap-1">
              {steps.map((step, i) => (
                <div key={step.stepType} className="flex items-center gap-1">
                  <div
                    className={`inline-flex flex-col items-center rounded-lg border px-3 py-1.5 text-micro ${
                      isRetryStep(step.stepType)
                        ? "border-brand bg-brand-bg text-brand-text"
                        : "border-border bg-bg text-text-secondary"
                    }`}
                  >
                    <span className="font-medium">
                      {isRetryStep(step.stepType) ? "Retry" : "Email"}
                    </span>
                    <span className="font-mono text-caption opacity-70">
                      {formatOffset(step.offsetHours)}
                    </span>
                  </div>
                  {i < steps.length - 1 ? (
                    <div className="h-px w-4 shrink-0 bg-border" aria-hidden />
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Hours to the shortest human form legacy uses: "1 hr" under a day, "Day N"
 *  above it. Derived so a schedule change moves the picture. */
function formatOffset(hours: number): string {
  if (hours < 24) return hours === 1 ? "1 hr" : `${hours} hr`;
  return `Day ${Math.round(hours / 24)}`;
}

/** The three health bands with Foxhound's OWN cutoffs, replacing both legacy's
 *  HealthScoreBadge (0-33 / 34-66 / 67-100) and its ChurnRiskSummary, whose
 *  content is entirely the Teamflow demo's money. Legacy's cutoffs would call a
 *  38 in the middle band where Foxhound calls it at risk. */
function HealthBands() {
  const bands: [string, string, string][] = [
    ["At risk", `Below ${HEALTH_SCORE_AT_RISK_THRESHOLD}`, "text-error-text"],
    ["Watch", `${HEALTH_SCORE_AT_RISK_THRESHOLD} to ${WATCH_CEILING - 1}`, "text-brand-text"],
    ["Healthy", `${WATCH_CEILING} and above`, "text-green"],
  ];
  return (
    <div className="my-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      {bands.map(([name, range, className]) => (
        <div key={name} className={CARD}>
          <div className={CARD_LABEL}>{name}</div>
          <div className={`font-mono text-title font-medium ${className}`}>{range}</div>
        </div>
      ))}
    </div>
  );
}

/** Foxhound's customer directory columns. Legacy's table (blob `6ae7c73f`) has
 *  an Action column; `ai_recommended_actions` has no writer here, so that column
 *  is dropped rather than mocked, and Foxhound's Last seen and Signals are shown
 *  instead. Column names, not fabricated customers. */
function CustomerColumns() {
  const columns: [string, string][] = [
    ["Customer", "Name and email, from Stripe."],
    ["Plan", "The current plan tier."],
    ["MRR", "What that customer contributes each month."],
    ["Health", "The 0 to 100 score, in its band's colour."],
    ["Last seen", "When the customer was last active."],
    ["Signals", "What moved the score: recovery history, disputes, engagement."],
  ];
  return (
    <div className="my-6 overflow-x-auto">
      <table className="w-full text-label">
        <thead>
          <tr className="border-b border-border">
            <th className="py-2 pr-4 text-left font-medium text-text">Column</th>
            <th className="py-2 pr-4 text-left font-medium text-text">What it shows</th>
          </tr>
        </thead>
        <tbody className="text-text-secondary">
          {columns.map(([name, description]) => (
            <tr key={name} className="border-b border-border">
              <td className="py-2 pr-4">{name}</td>
              <td className="py-2 pr-4">{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The dispute state machine, in order, from `DISPUTE_STATE_LABELS`. Legacy's
 *  DisputesTablePreview mocks a list with a Triage column; Foxhound's list has
 *  no such column and its STATES are the thing worth teaching, because PRICING
 *  rev 3 makes the approval gate schema-enforced with no override. */
function DisputeStates() {
  const meaning: Record<string, string> = {
    draft: "Evidence is being assembled. Nothing has been submitted.",
    pending_review: "Evidence is ready and waiting for a person on your team.",
    approved: "Somebody approved it. It can now be submitted.",
    submitted: "Sent to Stripe. Waiting on the issuer.",
    resolved_won: "The issuer found for you.",
    resolved_lost: "The issuer found for the cardholder.",
  };
  return (
    <div className="my-6 flex flex-col gap-2">
      {Object.entries(DISPUTE_STATE_LABELS).map(([key, label], i) => (
        <div key={key} className={`flex items-start gap-3 ${CARD}`}>
          <span className="shrink-0 font-mono text-micro text-brand-text">
            {String(i + 1).padStart(2, "0")}
          </span>
          <div>
            <div className="text-label font-medium text-text">{label}</div>
            <div className="text-caption leading-relaxed text-text-secondary">
              {meaning[key] ?? ""}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const WIDGETS = {
  "audit-scopes": AuditScopes,
  "payment-statuses": PaymentStatuses,
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
