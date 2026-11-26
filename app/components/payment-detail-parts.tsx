import { formatDate, relative, toMs } from "capsomer/behavior/time";
import { Form } from "react-router";
import { ButtonLink } from "capsomer/react/link";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import {
  ATTRIBUTION_KIND_LABELS,
  RECOVERY_LIFECYCLE_LABELS,
  recoveryLifecycleStatus,
  recoveryLifecycleTone,
} from "~/lib/recovery/labels";
import {
  DEMO_DISABLED_REASON,
  PILL_TONE,
  declineValueClass,
  statusValueClass,
} from "~/lib/recovery/payment-detail";
import { declineWord } from "~/lib/recovery/payments-list";
import { isEmailStep } from "~/lib/recovery/schedule";
import type { AttributionKind } from "~/lib/constants";
import type { loader } from "~/routes/app/recovery/payments/detail";

type Detail = Awaited<ReturnType<typeof loader>>;
type FailedPayment = Detail["failedPayment"];
type Steps = Detail["steps"];
type Recovery = Detail["recovery"];

export function PaymentActionBar({
  isDemo,
  actionsVisible,
  visibleActions,
  busy,
  pressedIntent,
  demoReasonId,
  failedPayment,
}: {
  isDemo: boolean;
  actionsVisible: boolean;
  visibleActions: { intent: string; label: string; variant: string }[];
  busy: boolean;
  pressedIntent: FormDataEntryValue | null;
  demoReasonId: string;
  failedPayment: FailedPayment;
}) {
  return (
    <>
      {actionsVisible && !isDemo ? (
        <div className="fh-payment-chips">
          {visibleActions.map((a) => {
            const pressed = pressedIntent === a.intent;
            return (
              <Form key={a.intent} method="post">
                <input type="hidden" name="intent" value={a.intent} />
                <button
                  type="submit"
                  className="cap-btn"
                  data-variant={a.variant === "default" ? undefined : a.variant}
                  aria-disabled={busy ? true : undefined}
                  onClick={(e) => {
                    if (busy) e.preventDefault();
                  }}
                >
                  {pressed ? "Working..." : a.label}
                </button>
              </Form>
            );
          })}
        </div>
      ) : null}
      {actionsVisible && isDemo ? (
        <div className="fh-payment-chips">
          {visibleActions.map((a) => (
            <button
              key={a.intent}
              type="button"
              className="cap-btn"
              data-variant={a.variant === "default" ? undefined : a.variant}
              aria-disabled="true"
              aria-describedby={demoReasonId}
              title={DEMO_DISABLED_REASON}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="fh-payment-chips">
        {isDemo ? (
          <>
            <button
              type="button"
              className="cap-btn"
              data-size="sm"
              aria-disabled="true"
              aria-describedby={demoReasonId}
              title={DEMO_DISABLED_REASON}
            >
              View invoice in Stripe
            </button>
            <button
              type="button"
              className="cap-btn"
              data-size="sm"
              aria-disabled="true"
              aria-describedby={demoReasonId}
              title={DEMO_DISABLED_REASON}
            >
              View customer in Stripe
            </button>
          </>
        ) : (
          <>
            <ButtonLink
              size="sm"
              href={`https://dashboard.stripe.com/invoices/${failedPayment.stripeInvoiceId}`}
              away
              newTab
            >
              View invoice in Stripe
            </ButtonLink>
            <ButtonLink
              size="sm"
              href={`https://dashboard.stripe.com/customers/${failedPayment.stripeCustomerId}`}
              away
              newTab
            >
              View customer in Stripe
            </ButtonLink>
          </>
        )}
      </div>
      {isDemo ? (
        // Capsomer's disabled buttons keep focus and say why in visible text (button.md), not only in a title.
        <p className="fh-payment-pull">
          <span className="cap-btn-reason" id={demoReasonId}>
            {DEMO_DISABLED_REASON}
          </span>
        </p>
      ) : null}
    </>
  );
}

export function PaymentTiles({
  failedPayment,
  estimatedLtvCents,
  nowMs,
}: {
  failedPayment: FailedPayment;
  estimatedLtvCents: Detail["estimatedLtvCents"];
  nowMs: number;
}) {
  return (
    <div className="fh-payment-tiles">
      <Panel size="sm" title="Amount">
        <p className="fh-mono fh-title fh-bold cap-num fh-brand">
          {formatMoney(failedPayment.amountCents, failedPayment.currency)}
        </p>
      </Panel>
      <Panel size="sm" title="Decline">
        <p className={`fh-title fh-bold ${declineValueClass(failedPayment.declineCategory)}`}>
          {declineWord(failedPayment.declineCategory)}
        </p>
      </Panel>
      <Panel size="sm" title="Detected">
        <p className="fh-title fh-bold fh-text">
          {relative(toMs(failedPayment.detectedAt), nowMs, "UTC")}
        </p>
        <p className="fh-mt-2 fh-tiny fh-quiet">
          {formatDate(failedPayment.detectedAt, { style: "monthDay" }) ?? ""}
        </p>
      </Panel>
      <Panel size="sm" title="Customer age">
        <p className="fh-mono fh-title fh-bold cap-num fh-text">
          {failedPayment.customerAgeDays != null ? `${failedPayment.customerAgeDays}d` : "-"}
        </p>
        {/* Recova shows no subtext below two recovered payments. */}
        {estimatedLtvCents != null ? (
          <p className="fh-mt-2 fh-tiny fh-quiet">
            ~{formatMoney(Math.round(estimatedLtvCents), failedPayment.currency)} est. LTV
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

export function PaymentFactPanels({
  failedPayment,
  steps,
  recovery,
  previousFailures,
  nowMs,
}: {
  failedPayment: FailedPayment;
  steps: Steps;
  recovery: Recovery;
  previousFailures: Detail["previousFailures"];
  nowMs: number;
}) {
  const attributionKind = recovery?.attributionKind as AttributionKind | undefined;
  const emailSteps = steps.filter((s) => s.executedAt !== null && isEmailStep(s.stepType));
  const openedEmails = emailSteps.filter((s) => s.openedAt);
  const clickedEmails = emailSteps.filter((s) => s.clickedAt);
  return (
    <div className="fh-payment-panels">
      <Panel title="Decline details">
        <dl className="">
          <DetailRow
            label="Category"
            value={declineWord(failedPayment.declineCategory)}
            valueClass={declineValueClass(failedPayment.declineCategory)}
          />
          {failedPayment.declineCode ? (
            <DetailRow label="Code" value={failedPayment.declineCode} mono />
          ) : null}
          <DetailRow label="Invoice ID" value={failedPayment.stripeInvoiceId} mono small />
          <DetailRow label="Customer ID" value={failedPayment.stripeCustomerId} mono small />
          {failedPayment.customerSince ? (
            <DetailRow
              label="Customer since"
              value={failedPayment.customerSince.toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
                timeZone: "UTC",
              })}
            />
          ) : null}
          {failedPayment.resolvedAt ? (
            <DetailRow
              label={failedPayment.status === "recovered" ? "Recovered" : "Resolved"}
              value={formatDate(failedPayment.resolvedAt, { style: "medium" }) ?? ""}
            />
          ) : null}
        </dl>
      </Panel>

      <Panel title="Email engagement">
        {emailSteps.length === 0 ? (
          <p className="fh-small fh-quiet">No emails sent yet</p>
        ) : (
          <dl className="">
            <DetailRow label="Emails sent" value={String(emailSteps.length)} />
            <DetailRow
              label="Opened"
              value={`${openedEmails.length} of ${emailSteps.length}`}
              valueClass={openedEmails.length > 0 ? "fh-green" : "fh-quiet"}
            />
            <DetailRow
              label="Clicked"
              value={`${clickedEmails.length} of ${emailSteps.length}`}
              valueClass={clickedEmails.length > 0 ? "fh-green" : "fh-quiet"}
            />
            {recovery ? (
              <DetailRow
                label="Recovery method"
                value={ATTRIBUTION_KIND_LABELS[attributionKind ?? "stripe_baseline"]}
                valueClass="fh-green"
              />
            ) : null}
          </dl>
        )}

        {previousFailures.length > 0 ? (
          <>
            <p className="fh-payment-links-title fh-tiny fh-medium fh-quiet">
              Previous failures ({previousFailures.length})
            </p>
            <ul className="">
              {previousFailures.map((p) => (
                <li key={p.id}>
                  <a href={`/recovery/payments/${p.id}`} className="fh-payment-link">
                    <span className="fh-tiny fh-quiet">
                      {relative(toMs(p.detectedAt), nowMs, "UTC")}
                    </span>
                    <span className="fh-payment-link-label">
                      <Pill variant="outline">{declineWord(p.declineCategory)}</Pill>
                      <span className={`fh-mono fh-tiny ${statusValueClass(p.status)}`}>
                        {formatMoney(p.amountCents, p.currency)}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Panel>
    </div>
  );
}

export function OutcomePanel({ recovery, steps }: { recovery: Recovery; steps: Steps }) {
  const attributionKind = recovery?.attributionKind as AttributionKind | undefined;
  const creditedStep =
    recovery?.recoveredByStepId != null
      ? steps.find((s) => s.id === recovery.recoveredByStepId)
      : undefined;
  return (
    <div className="fh-payment-outcome">
      <h2 className="fh-mono fh-tiny fh-brand fh-caps">Outcome</h2>
      {recovery ? (
        <div className="cap-stack fh-mt-3" data-gap="3">
          <div className="cap-cluster" data-gap="3">
            <Pill tone={PILL_TONE[recoveryLifecycleTone(recovery)]}>
              {RECOVERY_LIFECYCLE_LABELS[recoveryLifecycleStatus(recovery)]}
            </Pill>
          </div>
          {attributionKind ? (
            <div className="cap-cluster" data-gap="3">
              <span className="fh-mono fh-tiny fh-soft fh-caps">Attribution</span>
              <Pill variant="outline">
                {ATTRIBUTION_KIND_LABELS[attributionKind]}
                {attributionKind === "stripe_baseline" ? " - FREE" : ""}
              </Pill>
              {creditedStep ? (
                <span className="fh-small fh-soft">Credited to {creditedStep.label}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
  small,
  valueClass,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="fh-payment-fact">
      <dt className="cap-keep fh-tiny fh-quiet">{label}</dt>
      <dd
        className={`fh-payment-fact-value fh-truncate fh-right ${small ? "fh-tiny" : "fh-small"} ${
          mono ? "fh-mono" : ""
        } ${valueClass ?? "fh-text"}`}
      >
        {value}
      </dd>
    </div>
  );
}
