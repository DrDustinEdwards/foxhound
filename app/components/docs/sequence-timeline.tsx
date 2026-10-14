import { DECLINE_CATEGORY_LABELS } from "~/lib/recovery/labels";
import { RECOVERY_SCHEDULES, isRetryStep } from "~/lib/recovery/schedule";
import type { DeclineCategory } from "~/lib/constants";

// Ported from legacy components/docs/SequenceTimeline.tsx. Legacy's TREATMENT
// is carried over exactly: a surface card with a bordered rounded pill per
// step, blue for email and teal for retry, a mono timing line beneath each
// label, hairline connectors between them, and a horizontal scroll on narrow
// viewports.
//
// The DATA is Foxhound's, read from RECOVERY_SCHEDULES rather than restated
// (ruling 78). Legacy hardcodes its own cadence, which is email-first over four
// categories; Foxhound's engine is silent-retry-first over six. Shipping
// legacy's array would have drawn a diagram that contradicts the code actually
// scheduling the steps, on a payments product. Driving it from the schedule
// also means the diagram cannot drift from the engine later.
//
// NOTE, raised not resolved: the silent-retry-first ordering is recorded in
// schedule.ts:24 as "a deliberate change from legacy" with no ratification line.
// That conflict is logged against the recovery rows (ruling 80); this component
// renders whatever the engine actually does, either way.
function timingLabel(offsetHours: number): string {
  if (offsetHours < 24) return `${offsetHours} hr`;
  return `Day ${Math.round(offsetHours / 24)}`;
}

export function SequenceTimeline({ category }: { category: DeclineCategory }) {
  const steps = RECOVERY_SCHEDULES[category];

  return (
    <div className="my-4 rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 text-micro font-medium uppercase tracking-widest text-text-tertiary">
        {DECLINE_CATEGORY_LABELS[category]}: {steps.length} {steps.length === 1 ? "step" : "steps"}
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max items-center gap-1">
          {steps.map((step, i) => (
            <div key={step.stepType} className="flex items-center gap-1">
              <div
                className={`inline-flex flex-col items-center rounded-lg border px-3 py-1.5 text-micro ${
                  isRetryStep(step.stepType)
                    ? "border-brand-border-interactive bg-brand-bg text-brand-text"
                    : "border-blue bg-blue-bg text-blue"
                }`}
              >
                <span className="font-medium">{isRetryStep(step.stepType) ? "Retry" : "Email"}</span>
                <span className="font-mono text-micro opacity-70">{timingLabel(step.offsetHours)}</span>
              </div>
              {i < steps.length - 1 ? (
                <div className="h-px w-4 shrink-0 bg-border" aria-hidden="true" />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
