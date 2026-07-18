import { Badge } from "~/components/badge";
import { getDb } from "~/db";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { authContext } from "~/lib/auth/context";
import { formatMoney } from "~/lib/money-format";
import {
  ATTRIBUTION_KIND_LABELS,
  DECLINE_CATEGORY_LABELS,
  FAILED_PAYMENT_STATUS_LABELS,
  RECOVERY_LIFECYCLE_LABELS,
  failedPaymentStatusTone,
  formatStepResult,
  formatStepType,
  recoveryLifecycleStatus,
  recoveryLifecycleTone,
  stepResultTone,
} from "~/lib/recovery/labels";
import { getFailedPaymentDetail } from "~/lib/recovery/queries.server";
import { isRetryStep } from "~/lib/recovery/schedule";
import type { AttributionKind } from "~/lib/constants";

import type { Route } from "./+types/detail";

export function meta() {
  return [{ title: "Payment detail - Foxhound" }];
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const detail = await getFailedPaymentDetail(db, auth.membership.accountId, params.id);
  if (!detail) throw new Response("Not Found", { status: 404 });
  return detail;
}

export default function PaymentDetail({ loaderData }: Route.ComponentProps) {
  const { failedPayment, steps, recovery } = loaderData;
  const attributionKind = recovery?.attributionKind as AttributionKind | undefined;
  const creditedStep =
    recovery?.recoveredByStepId != null
      ? steps.find((s) => s.id === recovery.recoveredByStepId)
      : undefined;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-title font-medium text-text">
              {failedPayment.customerName ?? failedPayment.customerEmail}
            </h1>
            <p className="mt-1 text-label text-text-tertiary">{failedPayment.customerEmail}</p>
          </div>
          <p className="font-mono text-title text-text">
            {formatMoney(failedPayment.amountCents, failedPayment.currency)}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone={failedPaymentStatusTone(failedPayment.status)}>
            {FAILED_PAYMENT_STATUS_LABELS[failedPayment.status] ?? failedPayment.status}
          </Badge>
          <Badge tone="neutral">
            {DECLINE_CATEGORY_LABELS[failedPayment.declineCategory as keyof typeof DECLINE_CATEGORY_LABELS] ??
              failedPayment.declineCategory}
          </Badge>
          {failedPayment.declineCode ? (
            <span className="font-mono text-micro text-text-subtle">{failedPayment.declineCode}</span>
          ) : null}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Outcome</p>
        {recovery ? (
          <div className="mt-2 flex flex-col gap-2">
            {/* The real lifecycle state, read from refunded_at/disputed_at, never
                from attribution_kind: a refunded or disputed recovery must never
                read as a clean win regardless of how it was attributed. Billability
                itself is not asserted here at all, that is the 5d ledger's job off
                app/db/billable.ts. */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={recoveryLifecycleTone(recovery)}>
                {RECOVERY_LIFECYCLE_LABELS[recoveryLifecycleStatus(recovery)]}
              </Badge>
            </div>
            {attributionKind ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                  Attribution
                </span>
                <Badge tone="neutral">
                  {ATTRIBUTION_KIND_LABELS[attributionKind]}
                  {attributionKind === "stripe_baseline" ? " - FREE" : ""}
                </Badge>
                {creditedStep ? (
                  <span className="text-label text-text-tertiary">
                    Credited to {formatStepType(creditedStep.stepType)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-label text-text-tertiary">Still in recovery, no outcome yet.</p>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface p-4">
        <p className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
          Recovery timeline
        </p>
        {steps.length === 0 ? (
          <p className="mt-2 text-label text-text-tertiary">No steps scheduled.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-3">
            {steps.map((step) => {
              const channel = isRetryStep(step.stepType)
                ? "Silent"
                : step.stepType === "card_update"
                  ? "Customer action"
                  : "Customer email";
              return (
                <li
                  key={step.id}
                  className="flex items-center justify-between gap-4 border-b border-border-sub pb-3 last:border-0 last:pb-0"
                >
                  <div>
                    <p className="text-body text-text">
                      {step.stepNumber ?? "-"}. {formatStepType(step.stepType)}
                      <span className="ml-2 text-micro uppercase tracking-wide text-text-subtle">
                        {channel}
                      </span>
                    </p>
                    <p className="text-label text-text-tertiary">
                      {step.executedAt
                        ? `Ran ${step.executedAt.toLocaleString()}`
                        : `Scheduled for ${step.scheduledAt.toLocaleString()}`}
                    </p>
                  </div>
                  <Badge tone={stepResultTone(step.result)}>
                    {step.result ? formatStepResult(step.result) : "Pending"}
                  </Badge>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
