import { Icon, iconCheck, iconCircle, iconMail, iconReset } from "capsomer/react/icons";
import { formatDate, relative, toMs, until } from "capsomer/behavior/time";
import { useState } from "react";
import { Panel } from "capsomer/react/panel";
import { ExpandToggle } from "capsomer/react/disclosure";
import { Pill } from "capsomer/react/status";
import { markup } from "capsomer/behavior/trusted-html";
import { clickSuspectLabel, stepResultTone, type Tone } from "~/lib/recovery/labels";
import { PILL_TONE, stepResultWords } from "~/lib/recovery/payment-detail";
import { isEmailStep } from "~/lib/recovery/schedule";
import type { loader } from "~/routes/app/recovery/payments/detail";

type Steps = Awaited<ReturnType<typeof loader>>["steps"];

export function RecoveryTimeline({ steps, nowMs }: { steps: Steps; nowMs: number }) {
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const executedSteps = steps.filter((s) => s.executedAt !== null);
  return (
    <div className="fh-mb-5-5">
      <Panel
        title="Recovery timeline"
        src={`${executedSteps.length} of ${steps.length} steps executed`}
        flush
      >
        {steps.length === 0 ? (
          <div className="fh-payment-empty fh-center">
            <p className="fh-small fh-quiet">No recovery steps scheduled</p>
          </div>
        ) : (
          <ol className="fh-py-3">
            {steps.map((step) => {
              const executed = step.executedAt !== null;
              const pending = !executed && step.result === null;
              const email = isEmailStep(step.stepType);
              const showEngagement = executed && email && step.result !== "email_failed";
              const showExpander = executed && step.previewHtml !== null;
              const expanded = expandedStepId === step.id;
              return (
                <li key={step.id} className="fh-payment-step">
                  <StepGlyph
                    executed={executed}
                    isEmail={email}
                    tone={stepResultTone(step.result)}
                  />
                  <div className="cap-grow">
                    <div className="fh-payment-step-top">
                      <div className="fh-payment-step-meta">
                        <span className="fh-small fh-medium fh-text">{step.label}</span>
                        <Pill tone={PILL_TONE[stepResultTone(step.result)]}>
                          {stepResultWords(step.result, executed)}
                        </Pill>
                      </div>
                      <span className="fh-nowrap fh-mono fh-tiny fh-quiet">
                        {executed
                          ? relative(toMs(step.executedAt), nowMs, "UTC")
                          : pending
                            ? until(toMs(step.scheduledAt), nowMs)
                            : ""}
                      </span>
                    </div>
                    {email && step.aiSubject ? (
                      <p className="fh-mb-2 fh-tiny fh-quiet">&quot;{step.aiSubject}&quot;</p>
                    ) : null}
                    <p className="fh-tiny fh-quiet">
                      {executed
                        ? `Executed ${formatDate(step.executedAt, { style: "medium" }) ?? ""}`
                        : `Scheduled ${formatDate(step.scheduledAt, { style: "medium" }) ?? ""}`}
                    </p>

                    {showEngagement || showExpander ? (
                      <div className="cap-cluster fh-mt-3" data-gap="5">
                        {showEngagement ? (
                          <>
                            <span
                              data-gap="2"
                              className={`cap-cluster fh-tiny ${
                                step.openedAt ? "fh-green" : "fh-quiet"
                              }`}
                            >
                              {step.openedAt ? (
                                <Icon d={iconCheck} className="fh-icon-12 fh-icon-fine" />
                              ) : (
                                <Icon d={iconCircle} className="fh-icon-12 fh-icon-fine" />
                              )}
                              {step.openedAt
                                ? `Opened ${relative(toMs(step.openedAt), nowMs, "UTC")}`
                                : "Not opened"}
                            </span>
                            {/* A suspect click is shown as what it is:
                                  something fetched the link, and it is not billed. */}
                            <span
                              data-gap="2"
                              className={`cap-cluster fh-tiny ${
                                step.clickedAt && !step.clickSuspectReason ? "fh-green" : "fh-quiet"
                              }`}
                            >
                              {step.clickedAt && !step.clickSuspectReason ? (
                                <Icon d={iconCheck} className="fh-icon-12 fh-icon-fine" />
                              ) : (
                                <Icon d={iconCircle} className="fh-icon-12 fh-icon-fine" />
                              )}
                              {step.clickedAt
                                ? step.clickSuspectReason
                                  ? `Clicked ${relative(toMs(step.clickedAt), nowMs, "UTC")}, not counted (${clickSuspectLabel(step.clickSuspectReason)})`
                                  : `Clicked ${relative(toMs(step.clickedAt), nowMs, "UTC")}`
                                : "Not clicked"}
                            </span>
                          </>
                        ) : null}
                        {showExpander ? (
                          <span className="fh-tiny">
                            <ExpandToggle
                              label="View email"
                              openLabel="Hide email"
                              open={expanded}
                              onToggle={() => setExpandedStepId(expanded ? null : step.id)}
                              controls={`step-email-${step.id}`}
                            />
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {step.previewHtml && expanded ? (
                      <div
                        id={`step-email-${step.id}`}
                        className="fh-box fh-payment-preview fh-small fh-text"
                        // Sanitized in the loader by sanitizeEmailPreviewHtml; the raw body never reaches the browser.
                        dangerouslySetInnerHTML={markup(step.previewHtml)}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
    </div>
  );
}

/** The timeline node: a 32px round node with an envelope on an email step and a repeat glyph on a retry, tinted by the result once executed and gray while pending, the same tone as the result chip beside it so the two always agree. Capsomer has no timeline node; this is the page's own until it does. */
function StepGlyph({
  executed,
  isEmail,
  tone,
}: {
  executed: boolean;
  isEmail: boolean;
  tone: Tone;
}) {
  const skin = !executed
    ? "fh-payment-dot-pending"
    : tone === "success"
      ? "fh-payment-dot-success"
      : tone === "failure"
        ? "fh-payment-dot-failure"
        : "fh-payment-dot-neutral";
  return (
    <span className={`fh-payment-step-dot ${skin}`}>
      <Icon d={isEmail ? iconMail : iconReset} className="fh-icon-14 fh-icon-fine" />
    </span>
  );
}
